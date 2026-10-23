/**
 * The spend guard: one hard USD ceiling over everything this plugin's
 * `muse serve` child does.
 *
 * MSP reports spend in two places: `session/tokenUsage` carries the server's
 * own cumulative estimate, and `turn/completed` carries per-turn token
 * counters. Both are folded into one small JSON ledger under
 * `~/.dsh/muse-code-spend.json` so the ceiling survives a reload of the plugin
 * or of DeepSeek Harness itself.
 *
 * The safety argument rests on the model catalog. A single call can never cost
 * more than `context_limit * inputPrice + output_limit * outputPrice` per
 * million tokens, so checking that bound after every completed call keeps the
 * running total under the cap without ever knowing what the next prompt will
 * be. Nothing here uses an average or an observed historical cost on purpose:
 * a cheap call today says nothing about the worst call tomorrow.
 *
 * Failure always leans towards "refuse": an unreadable ledger locks the guard,
 * an unreadable catalog pauses it (`catalog-missing`), and an unknown model is
 * priced at the most expensive row in the catalog.
 *
 * @module dsh-muse-code/budget
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Default hard ceiling, in USD. */
export const DEFAULT_CAP_USD = 10

/** Ledger schema version written by this module. */
export const SPEND_STATE_VERSION = 1

/** Fallback context window (tokens) when a catalog row omits a usable one. */
const DEFAULT_CONTEXT_LIMIT = 1_007_997

/** Fallback max output (tokens) when a catalog row omits a usable one. */
const DEFAULT_OUTPUT_LIMIT = 128_000

/** Catalog prices are USD per million tokens. */
const PER_MILLION = 1_000_000

/** Float slack for comparing dollar amounts (`$10.0` must not look over cap). */
const EPSILON = 1e-9

/** Highest cap a user may set from the panel. */
const MAX_CAP_USD = 100_000

/** How many `sessionId:turnId` pairs the replay filter remembers. */
const TURN_DEDUPE_LIMIT = 500

/** Name of the ledger file inside `<home>/.dsh`. */
const DEFAULT_STATE_NAME = 'muse-code-spend.json'

/** Catalog directory the Muse CLI maintains under `<home>/.local/share`. */
const DEFAULT_CATALOG_PARTS = ['.local', 'share', 'muse', 'model-catalog']

/**
 * Coerce a JSON value to a finite number, or null. Numeric strings are
 * accepted because the catalog stores every price as a string.
 * @param {unknown} value - raw JSON value.
 * @returns {number | null} the number or null.
 */
function toNumber(value) {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null
	if (typeof value === 'string') {
		const text = value.trim()
		if (text === '') return null
		const parsed = Number(text)
		return Number.isFinite(parsed) ? parsed : null
	}
	return null
}

/**
 * Coerce to a non-negative money value, defaulting to 0.
 * @param {unknown} value - raw value.
 * @returns {number} a finite, non-negative number.
 */
function money(value) {
	const parsed = toNumber(value)
	return parsed === null ? 0 : Math.max(0, parsed)
}

/**
 * The price triple used by the costing helpers.
 * @param {{input: number|null, output: number|null, cached: number|null}} row - a catalog row.
 * @returns {{input: number, output: number, cached: number} | null} usable prices.
 */
function priceOf(row) {
	if (row === undefined || row === null) return null
	if (row.input === null || row.output === null) return null
	return { input: row.input, output: row.output, cached: row.cached === null ? row.input : row.cached }
}

/**
 * Round a dollar amount to six decimals so the ledger and the panel never show
 * float noise (`0.30000000000000004`).
 * @param {number} value - USD amount.
 * @returns {number} the amount rounded to 6 decimals.
 */
export function roundUsd(value) {
	return Math.round(value * 1e6) / 1e6
}

/**
 * Render a dollar amount for the panel and the chat tools.
 * Sub-cent amounts keep four decimals so a reserve like `$0.1264` stays
 * readable; everything else keeps the familiar two.
 * @param {number} value - USD amount.
 * @returns {string} formatted text, `$?` when the value is not finite.
 */
export function formatUsd(value) {
	if (typeof value !== 'number' || !Number.isFinite(value)) return '$?'
	return '$' + (Math.abs(value) < 0.01 && value !== 0 ? value.toFixed(4) : value.toFixed(2))
}

/**
 * README-facing companion to {@link formatUsd}: always four decimals, used for
 * the reserve inside the Chinese refusal messages (`预留 $0.1264`).
 * @param {number} value - USD amount.
 * @returns {string} `$` plus four decimals.
 */
function formatReserve(value) {
	const amount = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
	return '$' + amount.toFixed(4)
}

/**
 * Worst-case cost of ONE model call, in USD.
 *
 * `context_limit` and `output_limit` are hard protocol limits, so no single
 * call can exceed this number even with a maximally long prompt and a
 * maximally long answer.
 *
 * @param {{contextLimit: number|null, outputLimit: number|null} | null | undefined} row - catalog row carrying the limits.
 * @param {{input: number|null, output: number|null, cached?: number|null}} prices - USD per million tokens.
 * @returns {number} USD, NaN when the prices cannot price anything.
 */
export function worstCaseCallUsd(row, prices) {
	const input = toNumber(prices?.input)
	const output = toNumber(prices?.output)
	if (input === null || output === null) return Number.NaN
	const contextLimit = toNumber(row?.contextLimit)
	const outputLimit = toNumber(row?.outputLimit)
	const contextTokens = contextLimit !== null && contextLimit > 0 ? contextLimit : DEFAULT_CONTEXT_LIMIT
	const outputTokens = outputLimit !== null && outputLimit > 0 ? outputLimit : DEFAULT_OUTPUT_LIMIT
	return (contextTokens * input + outputTokens * output) / PER_MILLION
}

/**
 * Price one token-counter payload.
 *
 * Two shapes are accepted, because Muse reports both:
 *  - `SessionTokenUsageParams.cumulative`: `{promptTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?}`;
 *  - `TokenUsage` on `turn/completed`: `{inputTokens, outputTokens, cachedTokens, cacheReadTokens?, cacheWriteTokens?}`.
 *
 * When the cache split is known, cached reads are billed at the cached price
 * and cache writes at the normal input price. When it is not known, every
 * prompt token is billed at the full input price — the conservative direction.
 *
 * @param {object | null | undefined} counters - token counters.
 * @param {{input: number|null, output: number|null, cached?: number|null} | null | undefined} price - USD per million tokens.
 * @returns {number | null} USD, or null when nothing can be priced.
 */
export function costFromCounters(counters, price) {
	if (counters === null || counters === undefined || typeof counters !== 'object') return null
	const priceInput = toNumber(price?.input)
	const priceOutput = toNumber(price?.output)
	if (priceInput === null || priceOutput === null) return null
	let prompt = toNumber(counters.promptTokens)
	if (prompt === null) prompt = toNumber(counters.inputTokens)
	if (prompt === null) return null
	const output = toNumber(counters.outputTokens) ?? 0
	const cacheRead = toNumber(counters.cacheReadTokens)
	const cacheWrite = toNumber(counters.cacheWriteTokens)
	const promptTokens = Math.max(0, prompt)
	const outputTokens = Math.max(0, output)
	if (cacheRead !== null && cacheWrite !== null) {
		const priceCached = toNumber(price?.cached)
		const cachedPrice = priceCached === null ? priceInput : priceCached
		const readTokens = Math.max(0, cacheRead)
		const writeTokens = Math.max(0, cacheWrite)
		const inputPortion = Math.max(0, promptTokens - readTokens - writeTokens)
		return (inputPortion * priceInput + readTokens * cachedPrice + writeTokens * priceInput + outputTokens * priceOutput) / PER_MILLION
	}
	return (promptTokens * priceInput + outputTokens * priceOutput) / PER_MILLION
}

/**
 * Turn one catalog row into the shape the rest of this module uses.
 * @param {object} raw - one entry of the catalog `rows` array.
 * @returns {object | null} the row, or null when it carries no model id.
 */
function buildRow(raw) {
	if (raw === null || typeof raw !== 'object') return null
	const modelId = typeof raw.model_id === 'string' ? raw.model_id.trim() : ''
	if (modelId === '') return null
	const cost = raw.cost !== null && typeof raw.cost === 'object' ? raw.cost : undefined
	return {
		modelId,
		displayLabel: typeof raw.display_label === 'string' ? raw.display_label : null,
		input: toNumber(cost?.input),
		output: toNumber(cost?.output),
		cached: toNumber(cost?.cached),
		contextLimit: toNumber(raw.context_limit),
		outputLimit: toNumber(raw.output_limit),
		backgroundAgentModel: typeof raw.background_agent_model === 'string' && raw.background_agent_model !== '' ? raw.background_agent_model : null,
		currency: typeof cost?.currency === 'string' ? cost.currency : null
	}
}

/**
 * Fold a catalog's `rows` array into the lookup shape. Exported for tests.
 * @param {Array<object>} rows - catalog rows.
 * @param {string | null} catalogPath - file the rows came from.
 * @returns {object} see {@link loadModelCatalog}.
 */
export function buildCatalog(rows, catalogPath) {
	const models = new Map()
	let defaultModelId
	let maxInput = null
	let maxOutput = null
	let maxCached = null
	let maxWorstCaseUsd = null
	for (const raw of Array.isArray(rows) ? rows : []) {
		const row = buildRow(raw)
		if (row === null) continue
		models.set(row.modelId, row)
		if (raw?.is_default === true && defaultModelId === undefined) defaultModelId = row.modelId
		if (row.input === null || row.output === null) continue
		maxInput = maxInput === null ? row.input : Math.max(maxInput, row.input)
		maxOutput = maxOutput === null ? row.output : Math.max(maxOutput, row.output)
		if (row.cached !== null) maxCached = maxCached === null ? row.cached : Math.max(maxCached, row.cached)
		const worst = worstCaseCallUsd(row, priceOf(row))
		if (Number.isFinite(worst)) maxWorstCaseUsd = maxWorstCaseUsd === null ? worst : Math.max(maxWorstCaseUsd, worst)
	}
	const maxPrices = maxInput === null || maxOutput === null
		? null
		: { input: maxInput, output: maxOutput, cached: maxCached === null ? maxInput : maxCached }
	return {
		models,
		defaultModelId,
		catalogPath: typeof catalogPath === 'string' && catalogPath !== '' ? catalogPath : null,
		maxPrices,
		maxWorstCaseUsd: maxWorstCaseUsd === null ? null : roundUsd(maxWorstCaseUsd)
	}
}

/**
 * Read the Muse model catalog.
 *
 * The CLI keeps a single `*.json` file in `<home>/.local/share/muse/model-catalog`;
 * the newest parseable one wins. A missing or unreadable directory yields an
 * empty catalog instead of an exception, because the caller must be able to
 * report `catalog-missing` rather than crash the plugin.
 *
 * @param {object} [options] - wiring.
 * @param {string} [options.catalogDir] - directory holding the catalog JSON.
 * @returns {{models: Map<string, object>, defaultModelId: string | undefined, catalogPath: string | null, maxPrices: {input: number, output: number, cached: number} | null, maxWorstCaseUsd: number | null}} the catalog.
 */
export function loadModelCatalog({ catalogDir } = {}) {
	const dir = typeof catalogDir === 'string' && catalogDir !== ''
		? catalogDir
		: join(homedir(), ...DEFAULT_CATALOG_PARTS)
	const empty = buildCatalog([], null)
	let files = []
	try {
		files = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() === true && entry.name.toLowerCase().endsWith('.json'))
			.map((entry) => {
				const path = join(dir, entry.name)
				let mtimeMs = 0
				try {
					mtimeMs = statSync(path).mtimeMs
				} catch {
					mtimeMs = 0
				}
				return { path, mtimeMs }
			})
			.sort((left, right) => right.mtimeMs - left.mtimeMs)
	} catch {
		return empty
	}
	for (const file of files) {
		let parsed
		try {
			parsed = JSON.parse(readFileSync(file.path, 'utf8'))
		} catch {
			continue
		}
		if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.rows)) continue
		return buildCatalog(parsed.rows, file.path)
	}
	return empty
}

/**
 * The USD estimate for one session: the largest of the three independent
 * sources. Each source is a *total* for the session, so taking the maximum
 * avoids double counting while never under-reporting.
 * @param {object} record - one session record.
 * @returns {number} USD.
 */
function sessionUsd(record) {
	return Math.max(money(record?.serverUsd), money(record?.localUsd), money(record?.turnUsd))
}

/**
 * One hard USD ceiling plus the ledger that remembers it.
 *
 * Constructing never throws: every failure is logged and degraded into a
 * locked guard (fail-closed) or an empty catalog (`catalog-missing`).
 */
export class SpendGuard {
	/** @type {object | undefined} host logger. */
	#logger
	/** @type {string} absolute path of the ledger JSON. */
	#stateFile
	/** @type {string} directory the model catalog lives in. */
	#catalogDir
	/** @type {number} hard ceiling in USD. */
	#capUsd
	/** @type {Map<string, object>} per-session spend records. */
	#sessions
	/** @type {Set<string>} recent `sessionId:turnId` keys. */
	#turnIds
	/** @type {boolean} sticky lock flag. */
	#locked
	/** @type {string | null} machine-readable lock reason. */
	#lockedCode
	/** @type {string | null} human (Chinese) lock reason. */
	#lockedReason
	/** @type {number | null} epoch ms of the lock. */
	#lockedAt
	/** @type {number | null} spend recorded when the lock engaged. */
	#spentUsdAtLock
	/** @type {string | null} model the last usage report mentioned. */
	#lastModelId
	/** @type {number} epoch ms of the last mutation. */
	#updatedAt
	/** @type {number} how many usage reports were applied. */
	#calls
	/** @type {number} reserve currently displayed in the snapshot. */
	#reservedUsd
	/** @type {boolean} whether the last ledger write failed. */
	#persistError
	/** @type {object} the loaded model catalog. */
	#catalog

	/**
	 * @param {object} [options] - wiring.
	 * @param {number} [options.capUsd] - hard ceiling in USD, default 10.
	 * @param {string} [options.stateFile] - ledger path, default `~/.dsh/muse-code-spend.json`.
	 * @param {string} [options.catalogDir] - model catalog directory.
	 * @param {object} [options.logger] - host logger.
	 */
	constructor({ capUsd = DEFAULT_CAP_USD, stateFile, catalogDir, logger } = {}) {
		this.#logger = logger
		this.#stateFile = typeof stateFile === 'string' && stateFile !== ''
			? stateFile
			: join(homedir(), '.dsh', DEFAULT_STATE_NAME)
		this.#catalogDir = typeof catalogDir === 'string' && catalogDir !== ''
			? catalogDir
			: join(homedir(), ...DEFAULT_CATALOG_PARTS)
		this.#capUsd = typeof capUsd === 'number' && Number.isFinite(capUsd) && capUsd > 0 ? capUsd : DEFAULT_CAP_USD
		this.#sessions = new Map()
		this.#turnIds = new Set()
		this.#locked = false
		this.#lockedCode = null
		this.#lockedReason = null
		this.#lockedAt = null
		this.#spentUsdAtLock = null
		this.#lastModelId = null
		this.#updatedAt = 0
		this.#calls = 0
		this.#reservedUsd = 0
		this.#persistError = false
		this.#catalog = buildCatalog([], null)
		try {
			this.#catalog = loadModelCatalog({ catalogDir: this.#catalogDir })
		} catch (error) {
			this.#logger?.warn?.('muse-code: model catalog unavailable: ' + String(error?.message ?? error))
			this.#catalog = buildCatalog([], null)
		}
		this.#ensureDir()
		this.#readLedger()
		this.#flush()
	}

	/** @returns {number} the hard ceiling in USD. */
	get capUsd() {
		return roundUsd(this.#capUsd)
	}

	/** @returns {number} total spend across every session, USD. */
	get spentUsd() {
		let total = 0
		for (const record of this.#sessions.values()) total += roundUsd(sessionUsd(record))
		return roundUsd(total)
	}

	/** @returns {boolean} whether the guard refuses every call. */
	get locked() {
		return this.#locked === true
	}

	/** @returns {boolean} whether at least one catalog row can be priced. */
	get catalogOk() {
		return this.#catalog.maxPrices !== null
	}

	/** @returns {string} absolute ledger path. */
	get stateFile() {
		return this.#stateFile
	}

	/**
	 * The panel-facing view of the guard. Every field is a plain JSON value.
	 * @returns {object} the snapshot.
	 */
	snapshot() {
		const capUsd = roundUsd(this.#capUsd)
		const spentUsd = this.spentUsd
		const remainingUsd = Math.max(0, roundUsd(capUsd - spentUsd))
		const reservedUsd = roundUsd(Math.max(0, money(this.#reservedUsd)))
		const availableUsd = Math.max(0, roundUsd(remainingUsd - reservedUsd))
		return {
			version: SPEND_STATE_VERSION,
			capUsd,
			spentUsd,
			remainingUsd,
			reservedUsd,
			availableUsd,
			locked: this.#locked === true,
			lockedCode: this.#lockedCode ?? null,
			lockedReason: this.#lockedReason ?? null,
			lockedAt: this.#lockedAt ?? null,
			spentUsdAtLock: this.#spentUsdAtLock === null ? null : roundUsd(this.#spentUsdAtLock),
			status: this.#locked === true ? 'locked' : remainingUsd < capUsd * 0.2 ? 'near' : 'ok',
			calls: this.#calls,
			sessions: this.#sessions.size,
			partial: [...this.#sessions.values()].some((record) => record.partial === true),
			catalogOk: this.catalogOk,
			catalogPath: this.#catalog.catalogPath ?? null,
			lastModelId: this.#lastModelId ?? null,
			updatedAt: this.#updatedAt
		}
	}

	/**
	 * Re-read the model catalog from disk.
	 * @returns {SpendGuard} this guard.
	 */
	reloadCatalog() {
		try {
			this.#catalog = loadModelCatalog({ catalogDir: this.#catalogDir })
		} catch (error) {
			this.#logger?.warn?.('muse-code: model catalog reload failed: ' + String(error?.message ?? error))
			this.#catalog = buildCatalog([], null)
		}
		return this
	}

	/**
	 * Record the reserve currently shown in the snapshot.
	 * @param {number | null} usd - reserve in USD, null when it cannot be computed.
	 * @returns {object} the snapshot.
	 */
	setReserve(usd) {
		const parsed = toNumber(usd)
		this.#reservedUsd = parsed === null ? 0 : Math.max(0, parsed)
		return this.snapshot()
	}

	/**
	 * The worst-case cost of the next call to `modelId`.
	 *
	 * Falls back to the most expensive catalog prices when the id is not listed,
	 * because an unknown model may well be a premium one; using the cheapest
	 * row would under-reserve. With the real catalog the most expensive row is
	 * `muse-wonder-1.0` at $6.592 per call.
	 *
	 * @param {string | undefined | null} modelId - the model the session is on.
	 * @returns {number | null} USD, or null when nothing can be priced.
	 */
	reserveFor(modelId) {
		const catalog = this.#catalog
		if (catalog.models.size === 0 && catalog.maxPrices === null) return null
		const wanted = modelId === undefined || modelId === null ? '' : String(modelId)
		let row = wanted === '' ? undefined : catalog.models.get(wanted)
		if (row === undefined && wanted === '') {
			// No model named at all (yet): the last one we saw, then the catalog default.
			row = catalog.models.get(this.#lastModelId ?? '') ?? catalog.models.get(catalog.defaultModelId ?? '')
		}
		const prices = priceOf(row) ?? catalog.maxPrices
		if (prices === null) return null
		let base = worstCaseCallUsd(row, prices)
		if (!Number.isFinite(base)) return null
		const backgroundId = row?.backgroundAgentModel ?? null
		if (backgroundId !== null) {
			// A model with a background agent may pay for that agent's model too.
			const background = catalog.models.get(backgroundId)
			const backgroundPrices = priceOf(background)
			if (backgroundPrices !== null) {
				const backgroundWorst = worstCaseCallUsd(background, backgroundPrices)
				if (Number.isFinite(backgroundWorst) && backgroundWorst > base) base = backgroundWorst
			}
		}
		return roundUsd(base)
	}

	/**
	 * Decide whether one more model call may start.
	 *
	 * `reserveUsd === null` means the catalog cannot price the call at all; the
	 * guard refuses without locking (`catalog-missing`), so a fixable
	 * environment problem never bricks the switch.
	 *
	 * @param {number | null} reserveUsd - worst-case cost of the next call.
	 * @returns {{allowed: boolean, reasonCode: string | null, reasonMessage: string, reserveUsd: number | null, snapshot: object}} the verdict.
	 */
	evaluate(reserveUsd) {
		const parsed = toNumber(reserveUsd)
		const reserve = parsed === null ? null : Math.max(0, parsed)
		this.#reservedUsd = reserve === null ? 0 : reserve
		const snapshot = this.snapshot()
		if (this.#locked === true) {
			return {
				allowed: false,
				reasonCode: this.#lockedCode ?? 'manual',
				reasonMessage: this.#lockedReason ?? this.#reasonText(this.#lockedCode ?? 'manual'),
				reserveUsd: reserve,
				snapshot
			}
		}
		if (reserve === null) {
			return { allowed: false, reasonCode: 'catalog-missing', reasonMessage: this.#reasonText('catalog-missing'), reserveUsd: null, snapshot }
		}
		const spentUsd = this.spentUsd
		if (spentUsd >= this.#capUsd - EPSILON) {
			return { allowed: false, reasonCode: 'cap-reached', reasonMessage: this.#reasonText('cap-reached'), reserveUsd: reserve, snapshot }
		}
		if (spentUsd + reserve > this.#capUsd + EPSILON) {
			return { allowed: false, reasonCode: 'safety-margin', reasonMessage: this.#reasonText('safety-margin'), reserveUsd: reserve, snapshot }
		}
		return { allowed: true, reasonCode: null, reasonMessage: '', reserveUsd: reserve, snapshot }
	}

	/**
	 * Apply one `session/tokenUsage` report.
	 *
	 * The server's own estimate wins when present; the locally computed estimate
	 * (from the cumulative counters) is kept beside it, and the session total is
	 * the larger of the two. Repeating the same report is a no-op.
	 *
	 * @param {object} input - one report.
	 * @param {string} [input.sessionId] - MSP session id.
	 * @param {object} [input.cumulative] - `SessionTokenUsageParams.cumulative`.
	 * @param {object} [input.usage] - optional `TokenUsage` fallback.
	 * @param {string} [input.modelId] - model the call used.
	 * @param {string} [input.turnId] - turn the call belongs to (informational here).
	 * @returns {{changed: boolean, snapshot: object}} whether anything moved.
	 */
	recordUsage({ sessionId, cumulative, usage, modelId, turnId } = {}) {
		const id = sessionId === undefined || sessionId === null || sessionId === '' ? 'unknown' : String(sessionId)
		const known = this.#sessions.get(id)
		const record = known ?? {
			serverUsd: 0,
			localUsd: 0,
			turnUsd: 0,
			partial: false,
			lastModelId: null,
			updatedAt: 0
		}
		let changed = known === undefined
		const serverUsd = toNumber(cumulative?.cost?.usd)
		if (serverUsd !== null) {
			const next = Math.max(0, serverUsd)
			if (next !== record.serverUsd) {
				record.serverUsd = next
				changed = true
			}
		}
		const price = this.#priceFor(modelId)
		let localUsd = costFromCounters(cumulative, price)
		if (localUsd === null && usage !== undefined && usage !== null) localUsd = costFromCounters(usage, price)
		if (localUsd !== null && Number.isFinite(localUsd) && localUsd !== record.localUsd) {
			record.localUsd = localUsd
			changed = true
		}
		if (cumulative?.cost?.partial === true && record.partial !== true) {
			record.partial = true
			changed = true
		}
		if (typeof modelId === 'string' && modelId !== '' && record.lastModelId !== modelId) {
			record.lastModelId = modelId
			changed = true
		}
		if (changed) {
			record.updatedAt = Date.now()
			this.#sessions.set(id, record)
			this.#calls += 1
			if (typeof modelId === 'string' && modelId !== '') this.#lastModelId = modelId
			this.#updatedAt = record.updatedAt
			this.flush()
		}
		return { changed, snapshot: this.snapshot() }
	}

	/**
	 * Apply one `turn/completed` usage report.
	 *
	 * Turn costs are *added*, since a turn is not a cumulative total. A replay
	 * of the same `sessionId:turnId` pair is ignored, so a duplicate event does
	 * not inflate the ledger.
	 *
	 * @param {object} input - one report.
	 * @param {string} [input.sessionId] - MSP session id.
	 * @param {object} [input.usage] - `TokenUsage` from `turn/completed`.
	 * @param {string} [input.modelId] - model the turn used.
	 * @param {string} [input.turnId] - turn id, used for the replay filter.
	 * @returns {{changed: boolean, snapshot: object}} whether anything moved.
	 */
	recordTurnUsage({ sessionId, usage, modelId, turnId } = {}) {
		const id = sessionId === undefined || sessionId === null || sessionId === '' ? 'unknown' : String(sessionId)
		let dedupeKey = null
		if (turnId !== undefined && turnId !== null && String(turnId) !== '') {
			dedupeKey = id + ':' + String(turnId)
			if (this.#turnIds.has(dedupeKey)) return { changed: false, snapshot: this.snapshot() }
			this.#rememberTurn(dedupeKey)
		}
		const cost = costFromCounters(usage, this.#priceFor(modelId))
		if (cost === null || !Number.isFinite(cost)) {
			if (dedupeKey !== null) this.flush()
			return { changed: false, snapshot: this.snapshot() }
		}
		const known = this.#sessions.get(id)
		const record = known ?? {
			serverUsd: 0,
			localUsd: 0,
			turnUsd: 0,
			partial: false,
			lastModelId: null,
			updatedAt: 0
		}
		record.turnUsd = money(record.turnUsd) + Math.max(0, cost)
		record.updatedAt = Date.now()
		if (typeof modelId === 'string' && modelId !== '') {
			record.lastModelId = modelId
			this.#lastModelId = modelId
		}
		this.#sessions.set(id, record)
		this.#calls += 1
		this.#updatedAt = record.updatedAt
		this.flush()
		return { changed: true, snapshot: this.snapshot() }
	}

	/**
	 * Lock the guard. Idempotent: an existing code is never overwritten, so a
	 * stale `cap-reached` cannot mask a `ledger-corrupt`.
	 * @param {string} code - `cap-reached` | `safety-margin` | `ledger-corrupt` | `manual` | `catalog-missing`.
	 * @returns {object} the snapshot.
	 */
	lock(code) {
		if (this.#locked === true) return this.snapshot()
		const normalized = typeof code === 'string' && code !== '' ? code : 'manual'
		this.#locked = true
		this.#lockedCode = normalized
		this.#lockedReason = this.#reasonText(normalized)
		this.#lockedAt = Date.now()
		this.#spentUsdAtLock = this.spentUsd
		this.#updatedAt = this.#lockedAt
		this.#logger?.warn?.('muse-code: spend guard locked (' + normalized + '): ' + String(this.#lockedReason))
		this.flush()
		return this.snapshot()
	}

	/**
	 * Change the ceiling. Raising it above `spent + reserve` unlocks the guard,
	 * except after a corrupt ledger: that one stays locked until an explicit
	 * `reset()`, because its spend total is not trustworthy.
	 * @param {number} capUsd - new ceiling, 0 < cap <= 100000.
	 * @returns {object} the snapshot.
	 */
	setCap(capUsd) {
		if (typeof capUsd !== 'number' || !Number.isFinite(capUsd) || capUsd <= 0 || capUsd > MAX_CAP_USD) {
			throw new Error('花费上限必须是 0 到 100000 之间的数字')
		}
		this.#capUsd = capUsd
		this.#updatedAt = Date.now()
		if (this.#locked === true && this.#lockedCode !== 'ledger-corrupt') {
			const reserve = money(this.#reservedUsd)
			if (this.spentUsd + reserve <= capUsd + EPSILON) this.#clearLock()
		}
		this.flush()
		return this.snapshot()
	}

	/**
	 * Forget every recorded session and unlock, keeping the ceiling.
	 * @returns {object} the snapshot.
	 */
	reset() {
		this.#sessions.clear()
		this.#turnIds.clear()
		this.#calls = 0
		this.#clearLock()
		this.#updatedAt = Date.now()
		this.flush()
		return this.snapshot()
	}

	/**
	 * Write the ledger to disk synchronously (atomic replace). A write failure
	 * locks the guard: without a durable ledger the cap cannot be guaranteed.
	 * @returns {SpendGuard} this guard.
	 */
	flush() {
		this.#flush()
		return this
	}

	/**
	 * The price triple used to cost one report.
	 * @param {string | undefined | null} modelId - model id.
	 * @returns {{input: number, output: number, cached: number} | null} prices.
	 */
	#priceFor(modelId) {
		const row = this.#catalog.models.get(String(modelId ?? ''))
		const prices = priceOf(row)
		if (prices !== null) return prices
		return this.#catalog.maxPrices
	}

	/**
	 * Chinese refusal text for one lock/verdict code.
	 * @param {string} code - reason code.
	 * @returns {string} the message, with concrete numbers.
	 */
	#reasonText(code) {
		switch (code) {
			case 'cap-reached':
				return '已达到花费上限（' + formatUsd(this.#capUsd) + '），已强制停止。'
			case 'safety-margin':
				return '剩余额度不足以覆盖下一次调用的最坏成本（预留 ' + formatReserve(this.#reservedUsd) + '），为避免超支已停止。'
			case 'catalog-missing':
				return '无法读取 Muse 模型价格目录，为避免超支已暂停（fail-closed）。'
			case 'ledger-corrupt':
				return '花费账本损坏，按安全策略锁定；请检查后手动重置。'
			case 'manual':
				return '花费已手动锁定；请提高上限或重置花费记录后继续。'
			default:
				return '花费护栏已锁定（' + String(code) + '）；请提高上限或重置花费记录后继续。'
		}
	}

	/** Drop the lock fields. */
	#clearLock() {
		this.#locked = false
		this.#lockedCode = null
		this.#lockedReason = null
		this.#lockedAt = null
		this.#spentUsdAtLock = null
	}

	/**
	 * Remember one dedupe key, keeping the ring bounded.
	 * @param {string} key - `sessionId:turnId`.
	 */
	#rememberTurn(key) {
		this.#turnIds.add(key)
		while (this.#turnIds.size > TURN_DEDUPE_LIMIT) {
			const oldest = this.#turnIds.values().next()
			if (oldest.done === true) break
			this.#turnIds.delete(oldest.value)
		}
	}

	/** Create the ledger directory, degrading to a locked guard when it fails. */
	#ensureDir() {
		try {
			mkdirSync(dirname(this.#stateFile), { recursive: true })
		} catch (error) {
			this.#persistFailure(error, 'mkdir')
		}
	}

	/**
	 * Read the ledger. Anything unreadable is quarantined and locks the guard.
	 */
	#readLedger() {
		let raw
		try {
			raw = readFileSync(this.#stateFile, 'utf8')
		} catch (error) {
			if (error?.code === 'ENOENT') return
			this.#quarantine('read')
			this.#failClosedLock('ledger-corrupt', '花费账本无法读取（' + this.#stateFile + '），按安全策略已锁定；请检查后手动重置。')
			return
		}
		let parsed
		try {
			parsed = JSON.parse(raw)
		} catch {
			this.#quarantine('parse')
			this.#failClosedLock('ledger-corrupt', this.#reasonText('ledger-corrupt'))
			return
		}
		const sessionsOk = parsed?.sessions === undefined || (parsed?.sessions !== null && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions))
		if (parsed === null || typeof parsed !== 'object' || parsed.version !== SPEND_STATE_VERSION || !sessionsOk) {
			this.#quarantine('schema')
			this.#failClosedLock('ledger-corrupt', this.#reasonText('ledger-corrupt'))
			return
		}
		const storedCap = toNumber(parsed.capUsd)
		if (storedCap !== null && storedCap > 0) this.#capUsd = storedCap
		this.#locked = parsed.locked === true
		this.#lockedCode = typeof parsed.lockedCode === 'string' ? parsed.lockedCode : this.#locked ? 'manual' : null
		this.#lockedReason = typeof parsed.lockedReason === 'string' ? parsed.lockedReason : null
		this.#lockedAt = toNumber(parsed.lockedAt)
		this.#spentUsdAtLock = toNumber(parsed.spentUsdAtLock)
		this.#lastModelId = typeof parsed.lastModelId === 'string' && parsed.lastModelId !== '' ? parsed.lastModelId : null
		this.#updatedAt = toNumber(parsed.updatedAt) ?? 0
		if (parsed.sessions !== undefined && parsed.sessions !== null) {
			for (const [id, value] of Object.entries(parsed.sessions)) {
				if (value === null || typeof value !== 'object') continue
				this.#sessions.set(id, {
					serverUsd: money(value.serverUsd),
					localUsd: money(value.localUsd),
					turnUsd: money(value.turnUsd),
					partial: value.partial === true,
					lastModelId: typeof value.lastModelId === 'string' && value.lastModelId !== '' ? value.lastModelId : null,
					updatedAt: toNumber(value.updatedAt) ?? 0
				})
			}
		}
	}

	/**
	 * Keep a broken ledger next to the new one instead of deleting it.
	 * @param {string} phase - which read step failed.
	 */
	#quarantine(phase) {
		const target = this.#stateFile + '.corrupt-' + Date.now()
		try {
			renameSync(this.#stateFile, target)
			this.#logger?.warn?.('muse-code: spend ledger ' + phase + ' failed; kept as ' + target)
		} catch (error) {
			this.#logger?.warn?.('muse-code: spend ledger quarantine failed: ' + String(error?.message ?? error))
		}
	}

	/**
	 * Lock with an explicit message (used by the fail-closed paths).
	 * @param {string} code - reason code.
	 * @param {string} message - Chinese message.
	 */
	#failClosedLock(code, message) {
		if (this.#locked === true) return
		this.#locked = true
		this.#lockedCode = code
		this.#lockedReason = message
		this.#lockedAt = Date.now()
		this.#spentUsdAtLock = this.spentUsd
		this.#logger?.warn?.('muse-code: spend guard locked (fail-closed): ' + message)
	}

	/**
	 * Mark the ledger unwritable and lock: without persistence the cap cannot
	 * survive a restart, so spending must stop now.
	 * @param {unknown} error - the filesystem error.
	 * @param {string} phase - `mkdir` | `write`.
	 */
	#persistFailure(error, phase) {
		const detail = error === null || error === undefined ? '未知错误' : String(error?.message ?? error)
		if (this.#persistError !== true) {
			this.#persistError = true
			this.#logger?.warn?.('muse-code: spend ledger ' + phase + ' failed: ' + detail)
		}
		if (this.#locked !== true) {
			this.#locked = true
			this.#lockedCode = 'ledger-corrupt'
			this.#lockedReason = '花费账本无法写入（' + this.#stateFile + '），按安全策略已停止；请检查权限后手动重置。'
			this.#lockedAt = Date.now()
			this.#spentUsdAtLock = this.spentUsd
		}
	}

	/** @returns {object} the on-disk ledger payload. */
	#payload() {
		const sessions = Object.create(null)
		for (const [id, record] of this.#sessions) {
			sessions[id] = {
				serverUsd: money(record.serverUsd),
				localUsd: money(record.localUsd),
				turnUsd: money(record.turnUsd),
				partial: record.partial === true,
				lastModelId: record.lastModelId ?? null,
				updatedAt: record.updatedAt ?? 0
			}
		}
		return {
			version: SPEND_STATE_VERSION,
			capUsd: roundUsd(this.#capUsd),
			locked: this.#locked === true,
			lockedCode: this.#lockedCode ?? null,
			lockedReason: this.#lockedReason ?? null,
			lockedAt: this.#lockedAt ?? null,
			spentUsdAtLock: this.#spentUsdAtLock === null ? null : roundUsd(this.#spentUsdAtLock),
			lastModelId: this.#lastModelId ?? null,
			catalogPath: this.#catalog.catalogPath ?? null,
			sessions,
			updatedAt: this.#updatedAt
		}
	}

	/** Write the ledger atomically, locking the guard when the write fails. */
	#flush() {
		const payload = this.#payload()
		try {
			mkdirSync(dirname(this.#stateFile), { recursive: true })
			const temporary = this.#stateFile + '.tmp'
			writeFileSync(temporary, JSON.stringify(payload, null, 2) + '\n', 'utf8')
			renameSync(temporary, this.#stateFile)
			this.#persistError = false
		} catch (error) {
			this.#persistFailure(error, 'write')
		}
	}
}
