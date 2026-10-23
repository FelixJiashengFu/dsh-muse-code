/**
 * The Muse Code session as DeepSeek Harness sees it.
 *
 * One controller owns one `muse serve` child and one MSP session: it starts the
 * session on demand, folds the view stream into a small transcript, keeps the
 * pending approvals / user questions that the panel renders, and exposes the
 * operations chat tools and the panel both call. Approvals and answers are
 * only ever *decided* by the browser panel — the tools can read them but never
 * resolve them.
 *
 * @module dsh-muse-code/controller
 */

import { MspConnection, MspError, resolveMuseLaunch, uuidv7 } from './msp.js'

/** How many transcript items the snapshot keeps. */
const MAX_ITEMS = 400

/** How many settled user-input ids the pending backfill remembers. */
const SETTLED_QUESTION_MEMORY = 200

/** Housekeeping item kinds the transcript does not show. */
const HIDDEN_KINDS = new Set(['reminderChild', 'hookRun', 'monitorFeed', 'scheduledFire', 'damagedRange'])

/** Model-facing tool text never exceeds this. */
export const MAX_TOOL_TEXT = 24_000

/**
 * Append a streamed delta to a dotted field path ("text", "output",
 * "summary.0") of an item, creating the intermediate containers on the way.
 * @param {object} item - the item to mutate.
 * @param {string} field - dotted path.
 * @param {string} delta - appended text.
 */
function applyDelta(item, field, delta) {
	const path = (field === undefined || field === '' ? 'text' : field).split('.')
	let target = item
	for (let index = 0; index < path.length - 1; index += 1) {
		const key = path[index]
		const nextIsIndex = /^\d+$/.test(path[index + 1])
		if (target[key] === undefined || target[key] === null || typeof target[key] !== 'object') {
			target[key] = nextIsIndex ? [] : {}
		}
		target = target[key]
	}
	const last = path[path.length - 1]
	if (/^\d+$/.test(last)) {
		if (!Array.isArray(target)) return
		const slot = Number(last)
		target[slot] = String(target[slot] ?? '') + delta
		return
	}
	target[last] = String(target[last] ?? '') + delta
}

/**
 * Human label for one approval subject, mirroring how the CLI names it.
 * @param {object} subject - `ApprovalSubject`.
 * @returns {string} short label.
 */
export function describeSubject(subject) {
	if (subject === undefined || subject === null) return '未知操作'
	const what = subject.kind === 'shell'
		? subject.command
		: subject.kind === 'fileAccess'
			? subject.path
			: subject.kind === 'network'
				? [subject.host, subject.port].filter((part) => part !== undefined).join(':')
				: subject.target ?? subject.toolName ?? subject.path ?? ''
	return String(what ?? subject.kind)
}

/**
 * One live Muse session plus its folded transcript.
 */
export class MuseController {
	/**
	 * @param {object} options - wiring.
	 * @param {(spec: object) => object} options.spawn - `ctx.subprocess.spawn`.
	 * @param {object} options.logger - host logger.
	 * @param {() => string} options.resolveWorkspace - the workspace root to open the session in.
	 * @param {(event: object) => void} options.emit - fan-out to the panel stream.
	 * @param {string} [options.approvalMode] - MSP approval mode, default `onRequest`.
	 * @param {string} [options.modelId] - optional model override.
	 * @param {boolean} [options.disableSandbox] - launch the host with `--disable-sandbox`.
	 * @param {(reason: string) => void} [options.onStopped] - called once when the host
	 *   exits or the session unloads without the user having pressed stop.
	 * @param {object} [options.budget] - optional `SpendGuard`; when present every
	 *   start and every prompt is refused once the spend cap is reached, and the
	 *   session is torn down as soon as a completed call crosses it.
	 * @param {{argv: string[]}} [options.launch] - launch plan override; tests use
	 *   it to point the controller at a fake `muse serve`.
	 */
	constructor({ spawn, logger, resolveWorkspace, emit, approvalMode = 'onRequest', modelId, disableSandbox = false, onStopped, budget, launch }) {
		this.spawn = spawn
		this.logger = logger
		this.resolveWorkspace = resolveWorkspace
		this.emitEvent = emit
		this.onStopped = onStopped ?? (() => {})
		this.approvalMode = approvalMode
		this.modelId = modelId
		this.disableSandbox = disableSandbox
		/** Optional spend guard (`lib/budget.js`); undefined when the host has none. */
		this.budget = budget
		/** Launch plan override, mostly for the fake-server tests. */
		this.launch = launch
		/** True while the spend cap is tearing this session down. */
		this.enforcing = false
		this.workspaceOverride = undefined
		this.host = undefined
		this.connection = undefined
		this.enabled = false
		this.starting = undefined
		this.session = undefined
		/** Turn state: `starting` | `idle` | `running` | `off` | `error`. */
		this.status = 'off'
		/** MSP load state of the session: `idle` | `running` | `notLoaded`. */
		this.loadStatus = undefined
		/** Attention flags published by `session/statusChanged`. */
		this.attention = []
		/** True while the user's stop is driving the shutdown. */
		this.stopping = false
		/** Guards the one-shot `onStopped` handoff. */
		this.stopNotified = false
		/** True when the session unloaded and needs a restart. */
		this.needsRestart = false
		this.items = []
		this.index = new Map()
		this.approvals = new Map()
		this.questions = new Map()
		/** User-input ids that already settled; the pending backfill skips them. */
		this.settledQuestions = new Set()
		this.usage = undefined
		this.lastTurn = undefined
		this.lastError = undefined
		this.viewCursor = undefined
	}

	/** @returns {object} the panel-facing snapshot. */
	snapshot() {
		return {
			enabled: this.enabled,
			status: this.status,
			loadStatus: this.loadStatus ?? null,
			attention: this.attention,
			needsRestart: this.needsRestart,
			session: this.session === undefined ? null : {
				sessionId: this.session.sessionId,
				modelId: this.session.modelId,
				providerId: this.session.providerId,
				status: this.session.status,
				workspaceRoot: this.session.workspaceRoot,
				approvalMode: this.session.approvalMode?.mode,
				turnCount: this.session.turnCount
			},
			items: this.items,
			approvals: [...this.approvals.values()],
			questions: [...this.questions.values()],
			usage: this.usage ?? null,
			lastTurn: this.lastTurn ?? null,
			lastError: this.lastError ?? null,
			viewCursor: this.viewCursor ?? null,
			host: this.host === undefined ? null : {
				version: this.host.serverInfo?.version ?? null,
				platformFamily: this.host.platformFamily ?? null,
				sandbox: this.host.sandboxAvailability ?? null,
				sandboxReason: this.host.sandboxUnavailableReason ?? null,
				schemaVersion: this.host.schema?.version ?? null,
				schemaFingerprint: this.host.schema?.fingerprint ?? null
			},
			disableSandbox: this.disableSandbox,
			budget: this.budget === undefined ? null : this.budget.snapshot()
		}
	}

	/**
	 * Emit one event to the panel stream.
	 * @param {object} event - `{type, ...}` payload.
	 */
	#emit(event) {
		try {
			this.emitEvent(event)
		} catch (error) {
			this.logger?.warn?.('muse-code: emit failed: ' + String(error?.message ?? error))
		}
	}

	/**
	 * Start the host child and open one session.
	 * @returns {Promise<object>} the panel snapshot.
	 */
	async start() {
		if (this.enabled && this.session !== undefined) return this.snapshot()
		if (this.starting !== undefined) return this.starting
		this.starting = this.#start().finally(() => { this.starting = undefined })
		return this.starting
	}

	/** @returns {Promise<object>} the started snapshot. */
	async #start() {
		if (this.budget?.locked === true) {
			throw new MspError('花费上限已锁定：' + (this.budget.snapshot().lockedReason ?? '已达上限') + '。请在面板里提高上限或重置花费记录。', -32000)
		}
		// `session/closed` and `session/statusChanged: notLoaded` turn the switch
		// off but deliberately leave the child running, so reopening the panel can
		// reuse it. Starting a new session therefore has to retire the previous
		// child first: otherwise the old process becomes an orphan whose late exit
		// would overwrite the new session's state. Retiring happens after the
		// budget gate so a refused start never kills a live connection.
		if (this.connection !== undefined) await this.#retire()
		this.enforcing = false
		this.status = 'starting'
		this.lastError = undefined
		this.stopping = false
		this.stopNotified = false
		this.needsRestart = false
		this.attention = []
		this.loadStatus = undefined
		this.#emit({ type: 'status', status: this.status })
		const launch = this.launch ?? resolveMuseLaunch()
		const workspace = this.workspaceOverride ?? this.resolveWorkspace()
		try {
			const connection = new MspConnection({
				spawn: this.spawn,
				cwd: workspace,
				argv: [...launch.argv, '--provider', 'meta', '--trust-workspace', ...(this.disableSandbox ? ['--disable-sandbox'] : [])],
				logger: this.logger,
				// Every callback is bound to the connection it belongs to and
				// ignored once that connection is no longer the active one. A late
				// frame or a late `done` from a retired child must never fold into
				// (or tear down) the session that replaced it.
				onNotification: (method, params) => {
					if (this.connection !== connection) return
					this.#onNotification(method, params)
				},
				onServerRequest: (method, params) => {
					if (this.connection !== connection) return {}
					return this.#onServerRequest(method, params)
				},
				onExit: (code) => {
					if (this.connection !== connection) return
					this.connection = undefined
					const wasStopping = this.stopping
					this.stopping = false
					this.session = undefined
					this.status = 'off'
					this.enabled = false
					this.loadStatus = undefined
					this.attention = []
					if (wasStopping) {
						// A user-initiated stop: no failure text, just the state change.
						// `lastError` is left untouched (stop() clears it up front).
						this.#emit({ type: 'status', status: 'off' })
						this.#emit({ type: 'snapshot', snapshot: this.snapshot() })
						return
					}
					this.lastError = `Muse Code 进程已退出（code ${String(code)}）`
					this.#notifyStopped(this.lastError)
					this.#emit({ type: 'status', status: 'off', error: this.lastError })
					this.#emit({ type: 'snapshot', snapshot: this.snapshot() })
				}
			})
			this.connection = connection
			const init = await connection.connect()
			this.host = init
			this.logger?.info?.('muse-code: host ready ' + JSON.stringify(init?.serverInfo ?? {}))
			if (init?.sandboxAvailability === 'unavailable') {
				this.logger?.warn?.('muse-code: Muse cannot enforce its sandbox on this host; shell tools will fail unless the user enables the unsandboxed mode')
			}
			const started = await connection.request('session/start', {
				commandId: uuidv7(),
				workspaceRoot: workspace,
				approvalMode: this.approvalMode,
				...(this.modelId === undefined ? {} : { modelId: this.modelId })
			}, { timeoutMs: 120_000 })
			this.session = started?.session
			this.viewCursor = started?.viewCursor
			this.status = 'idle'
			this.loadStatus = started?.session?.status ?? 'idle'
			this.enabled = true
			this.items = []
			this.index = new Map()
			this.approvals = new Map()
			this.questions = new Map()
			this.usage = undefined
			this.lastTurn = undefined
			const verdict = this.#budgetPreflight()
			if (verdict !== undefined && verdict.allowed !== true) {
				// The session itself came up, but the guard refuses to spend on it:
				// publish and (for a spend lock) tear down in the background. Never
				// throw here, because the caller would then mistake a live session
				// for a failed start and the child would be orphaned.
				this.#applyBudgetVerdict(verdict)
			}
			this.#emit({ type: 'status', status: this.status })
			this.#emit({ type: 'snapshot', snapshot: this.snapshot() })
			return this.snapshot()
		} catch (error) {
			this.stopping = true
			this.lastError = error instanceof Error ? error.message : String(error)
			this.status = 'error'
			this.enabled = false
			this.session = undefined
			this.loadStatus = undefined
			await this.#teardown()
			// Nothing observed the forced stop, so the flag must not stay armed:
			// the next session/closed on a live connection would otherwise be read
			// as a user stop.
			this.stopping = false
			this.#emit({ type: 'status', status: this.status, error: this.lastError })
			throw error
		}
	}

	/**
	 * Hand the one-shot "the session is gone" signal to the host wiring.
	 * @param {string} reason - short human reason.
	 */
	#notifyStopped(reason) {
		if (this.stopNotified) return
		this.stopNotified = true
		this.enabled = false
		this.needsRestart = true
		try {
			this.onStopped(reason)
		} catch (error) {
			this.logger?.warn?.('muse-code: onStopped handler failed: ' + String(error?.message ?? error))
		}
	}

	/** Close the session and the child. */
	async stop() {
		const connection = this.connection
		const session = this.session
		this.stopping = true
		this.connection = undefined
		this.session = undefined
		this.enabled = false
		this.host = undefined
		this.status = 'off'
		this.lastError = undefined
		this.loadStatus = undefined
		this.attention = []
		this.needsRestart = false
		this.approvals.clear()
		this.questions.clear()
		this.#emit({ type: 'status', status: 'off' })
		this.#emit({ type: 'snapshot', snapshot: this.snapshot() })
		if (connection === undefined) {
			this.stopping = false
			return
		}
		try {
			if (session !== undefined) {
				await connection.request('session/leave', { sessionId: session.sessionId, commandId: uuidv7() }, { timeoutMs: 10_000 })
			}
		} catch {
			/* leaving is best effort */
		}
		await connection.stop()
		// `stop()` detached the connection, so its `onExit` will never run and
		// reset the flag; reset it here to keep `this.stopping` from staying armed.
		this.stopping = false
	}

	/** Drop the child without a graceful leave (used on failed starts). */
	async #teardown() {
		const connection = this.connection
		this.connection = undefined
		if (connection !== undefined) await connection.stop()
	}

	/**
	 * Stop the child a previous session left behind before a restart.
	 *
	 * The connection is detached from the controller first, so nothing it
	 * reports while it drains (including its exit) can reach the new session.
	 * A failure here is logged and ignored: refusing to start because an old
	 * child could not be killed would be worse than a lingering process.
	 *
	 * @returns {Promise<void>} resolves once the old child was asked to stop.
	 */
	async #retire() {
		const connection = this.connection
		this.connection = undefined
		if (connection === undefined) return
		this.logger?.debug?.('muse-code: retiring the previous host before a restart')
		try {
			await connection.stop()
		} catch (error) {
			this.logger?.warn?.('muse-code: could not stop the previous host: ' + String(error?.message ?? error))
		}
	}

	/**
	 * Start one turn.
	 * @param {string} text - prompt text.
	 * @param {object} [options] - turn knobs.
	 * @param {boolean} [options.steer] - steer the running turn instead of queueing.
	 * @returns {Promise<object>} the turn ack.
	 */
	async prompt(text, { steer = false } = {}) {
		const value = String(text ?? '').trim()
		if (value === '') throw new MspError('提示词不能为空', -32602)
		if (this.session === undefined) await this.start()
		const verdict = this.#budgetPreflight()
		if (verdict !== undefined && verdict.allowed !== true) {
			this.#applyBudgetVerdict(verdict)
			throw new MspError(verdict.reasonMessage, -32000)
		}
		const connection = this.#connection()
		const result = await connection.request('turn/start', {
			commandId: uuidv7(),
			sessionId: this.session.sessionId,
			input: [{ type: 'text', text: value }],
			ifBusy: steer ? 'steer' : 'queue'
		}, { timeoutMs: 120_000 })
		this.#emit({ type: 'prompt-ack', ack: result })
		return result
	}

	/**
	 * Interrupt the running turn (the "stop" gesture).
	 * @returns {Promise<object>} the interrupt ack.
	 */
	async interrupt() {
		if (this.session === undefined) throw new MspError('Muse Code 会话尚未启动', -32000)
		const connection = this.#connection()
		const result = await connection.request('turn/interrupt', {
			commandId: uuidv7(),
			sessionId: this.session.sessionId,
			...(this.lastTurn?.turnId === undefined ? {} : { turnId: this.lastTurn.turnId })
		}, { timeoutMs: 30_000 })
		return result
	}

	/**
	 * Resolve one pending approval. Only the panel calls this.
	 * @param {object} input - decision.
	 * @param {string} input.approvalId - approval to decide.
	 * @param {string} input.choiceId - one of the offered choices.
	 * @param {string} input.requirementId - the requirement stage the panel saw.
	 * @param {string} [input.feedback] - denial guidance.
	 * @returns {Promise<object>} the decide ack.
	 */
	async decide({ approvalId, choiceId, requirementId, feedback }) {
		if (this.session === undefined) throw new MspError('Muse Code 会话尚未启动', -32000)
		const connection = this.#connection()
		return connection.request('approval/decide', {
			sessionId: this.session.sessionId,
			approvalId,
			choiceId,
			requirementId,
			commandId: uuidv7(),
			...(feedback === undefined || feedback === '' ? {} : { feedback })
		}, { timeoutMs: 30_000 })
	}

	/**
	 * Answer one pending user-input prompt. Only the panel calls this.
	 * @param {object} input - answers.
	 * @param {string} input.userInputId - prompt id.
	 * @param {Array<object>} input.answers - one answer per question.
	 * @returns {Promise<object>} the answer ack.
	 */
	async answer({ userInputId, answers }) {
		if (this.session === undefined) throw new MspError('Muse Code 会话尚未启动', -32000)
		const connection = this.#connection()
		return connection.request('userInput/answer', {
			sessionId: this.session.sessionId,
			userInputId,
			answers,
			commandId: uuidv7()
		}, { timeoutMs: 30_000 })
	}

	/**
	 * Select a preconfigured approval mode. A user-only action.
	 * @param {string} mode - `allowAll` | `promptUnmatched` | `onRequest` | `denyUnmatched`.
	 * @returns {Promise<object>} the mode ack.
	 */
	async setApprovalMode(mode) {
		if (this.session === undefined) throw new MspError('Muse Code 会话尚未启动', -32000)
		const connection = this.#connection()
		return connection.request('session/setApprovalMode', {
			sessionId: this.session.sessionId,
			commandId: uuidv7(),
			mode
		}, { timeoutMs: 30_000 })
	}

	/**
	 * The current connection or a clear error.
	 * @returns {MspConnection} live connection.
	 */
	#connection() {
		if (this.connection === undefined || !this.connection.alive) {
			throw new MspError('Muse Code 连接已断开', -32000)
		}
		return this.connection
	}

	/**
	 * Ask the spend guard whether one more call may start.
	 *
	 * The raw `reserveFor()` answer is handed to `evaluate()` on purpose: a
	 * `null` reserve means "the catalog cannot price this call", and it has to
	 * reach the guard as `catalog-missing`. Going through `snapshot()` would
	 * flatten that `null` into a `0` and silently allow the call.
	 *
	 * @returns {object | undefined} the verdict, or `undefined` without a guard.
	 */
	#budgetPreflight() {
		if (this.budget === undefined) return undefined
		const modelId = this.session?.modelId ?? this.modelId
		const reserveUsd = this.budget.reserveFor(modelId)
		this.budget.setReserve(reserveUsd)
		return this.budget.evaluate(reserveUsd)
	}

	/**
	 * Start the one-shot budget shutdown. Repeated calls inside one session are
	 * ignored; `#start()` clears the flag when a new session comes up.
	 */
	#enforceBudgetLock() {
		if (this.budget === undefined || this.enforcing) return
		this.enforcing = true
		void this.#stopForBudget()
	}

	/**
	 * React to a preflight the guard did not allow.
	 *
	 * A spend or ledger lock is terminal for this session: latch it and tear the
	 * child down. A missing model catalog is different — the guard cannot price
	 * the next call, so the call is refused, but nothing is latched and the child
	 * stays up; the contract asks for fail-closed refusal there, not for a lock
	 * that would need a manual reset once the catalog is back.
	 *
	 * @param {object} verdict - a verdict whose `allowed` is not `true`.
	 */
	#applyBudgetVerdict(verdict) {
		if (verdict.reasonCode === 'catalog-missing') {
			this.logger?.warn?.('muse-code: spend guard cannot price the next call: ' + String(verdict.reasonMessage))
			this.#emit({ type: 'budget', budget: this.budget.snapshot() })
			return
		}
		this.budget.lock(verdict.reasonCode)
		this.#emit({ type: 'budget', budget: this.budget.snapshot() })
		this.#enforceBudgetLock()
	}

	/**
	 * Tear the session down after the cap was hit: interrupt (best effort),
	 * stop the child, then publish the reason.
	 *
	 * `stop()` clears `lastError` and emits its own status, so the failure text
	 * has to be set *after* it returns and published again — otherwise the panel
	 * would show a clean "off" for a session that was killed by the cap.
	 *
	 * @returns {Promise<void>} resolves once the panel was told.
	 */
	async #stopForBudget() {
		const reason = this.budget.snapshot().lockedReason ?? '已达到花费上限'
		this.logger?.warn?.('muse-code: spend cap locked: ' + String(reason))
		try {
			await this.interrupt()
		} catch {
			/* the turn may already be over */
		}
		try {
			await this.stop()
		} catch {
			/* 尽力关停 */
		}
		this.needsRestart = true
		this.lastError = '花费上限已触发：' + String(reason) + ' Muse Code 已强制停止，不会再发起任何模型调用。'
		this.#emit({ type: 'status', status: 'off', error: this.lastError })
		this.#emit({ type: 'snapshot', snapshot: this.snapshot() })
	}

	/**
	 * Fold one MSP notification into the transcript.
	 * @param {string} method - notification method.
	 * @param {object} params - notification params.
	 */
	#onNotification(method, params) {
		if (params?.viewCursor !== undefined && typeof params.viewCursor === 'string') this.viewCursor = params.viewCursor
		switch (method) {
			case 'item/started':
			case 'item/updated':
			case 'item/completed': {
				const item = params?.item
				if (item === undefined || item === null) return
				this.#upsertItem(item)
				return
			}
			case 'item/delta': {
				const item = this.index.get(params?.itemId)
				if (item === undefined) return
				applyDelta(item, params.field, String(params.delta ?? ''))
				this.#emit({ type: 'delta', itemId: item.itemId, field: params.field ?? 'text', delta: String(params.delta ?? '') })
				return
			}
			case 'turn/started': {
				this.status = 'running'
				this.lastTurn = { turnId: params.turnId, terminal: undefined, startedAt: Date.now() }
				if (this.session !== undefined) this.session.activeTurnId = params.turnId
				this.#emit({ type: 'status', status: this.status, turnId: params.turnId })
				return
			}
			case 'turn/completed': {
				this.status = 'idle'
				this.lastTurn = {
					turnId: params.turnId,
					terminal: params.terminal,
					error: params.error ?? null,
					durationMs: params.durationMs ?? null,
					usage: params.usage ?? null
				}
				if (this.session !== undefined) this.session.activeTurnId = null
				if (this.budget !== undefined) {
					const recorded = this.budget.recordTurnUsage({
						sessionId: params.sessionId ?? this.session?.sessionId,
						usage: params.usage,
						modelId: this.session?.modelId,
						turnId: params.turnId
					})
					if (recorded.changed) this.#emit({ type: 'budget', budget: this.budget.snapshot() })
				}
				this.#emit({ type: 'turn', turn: this.lastTurn })
				this.#emit({ type: 'status', status: this.status })
				return
			}
			case 'session/statusChanged': {
				// `status` here is the session's LOAD state, not the turn state.
				if (typeof params?.status === 'string') this.loadStatus = params.status
				this.attention = Array.isArray(params?.attention) ? params.attention : []
				if (this.loadStatus === 'notLoaded') {
					this.session = undefined
					this.enabled = false
					this.status = 'off'
					this.needsRestart = true
					this.#emit({ type: 'status', status: 'off' })
					this.#emit({ type: 'snapshot', snapshot: this.snapshot() })
					return
				}
				this.#emit({ type: 'load', loadStatus: this.loadStatus ?? null, attention: this.attention })
				return
			}
			case 'session/contextUsage': {
				this.usage = {
					usedTokens: params.usedTokens,
					windowTokens: params.windowTokens ?? null,
					pressure: params.pressure
				}
				this.#emit({ type: 'usage', usage: this.usage })
				return
			}
			case 'session/tokenUsage': {
				if (this.budget === undefined || params?.cumulative === undefined) return
				const recorded = this.budget.recordUsage({
					sessionId: params.sessionId ?? this.session?.sessionId,
					cumulative: params.cumulative,
					usage: params.usage,
					modelId: params.modelId ?? this.session?.modelId
				})
				if (recorded.changed) this.#emit({ type: 'budget', budget: this.budget.snapshot() })
				const verdict = this.#budgetPreflight()
				if (verdict !== undefined && verdict.allowed !== true) this.#applyBudgetVerdict(verdict)
				return
			}
			case 'approval/request':
			case 'approval/requested': {
				if (params?.approvalId === undefined) return
				const record = this.#fullApproval(params)
				this.approvals.set(params.approvalId, record)
				this.#emit({ type: 'approval', approval: record })
				return
			}
			case 'approval/updated': {
				if (params?.approvalId === undefined) return
				const previous = this.approvals.get(params.approvalId)
				if (previous !== undefined) {
					const merged = this.#mergeApproval(previous, params)
					this.approvals.set(params.approvalId, merged)
					this.#emit({ type: 'approval', approval: merged })
					return
				}
				// No local record yet (e.g. after a stream reconnect): read the
				// authoritative pending list before folding the partial change in.
				void this.#backfillPending(params)
				return
			}
			case 'approval/resolved': {
				if (params?.approvalId === undefined) return
				this.approvals.delete(params.approvalId)
				this.#emit({ type: 'approval-resolved', approvalId: params.approvalId, decision: params.decision })
				return
			}
			case 'userInput/requested': {
				if (params?.userInputId === undefined) return
				const record = {
					userInputId: params.userInputId,
					itemId: params.itemId,
					turnId: params.turnId,
					questions: Array.isArray(params.questions) ? params.questions : [],
					receivedAt: Date.now()
				}
				this.questions.set(params.userInputId, record)
				this.#emit({ type: 'question', question: record })
				return
			}
			case 'userInput/settled': {
				if (params?.userInputId === undefined) return
				this.#markQuestionSettled(params.userInputId)
				this.questions.delete(params.userInputId)
				this.#emit({ type: 'question-settled', userInputId: params.userInputId })
				return
			}
			case 'session/closed': {
				const wasStopping = this.stopping
				this.session = undefined
				this.status = 'off'
				this.enabled = false
				this.loadStatus = 'notLoaded'
				this.attention = []
				if (!wasStopping) this.#notifyStopped('Muse Code 会话已被关闭')
				this.#emit({ type: 'status', status: 'off' })
				this.#emit({ type: 'snapshot', snapshot: this.snapshot() })
				return
			}
			default:
				return
		}
	}

	/**
	 * Handle one server-initiated request: store it for the panel and hand back
	 * the presentation receipt. Deciding still travels as a command.
	 * @param {string} method - request method.
	 * @param {object} params - request params.
	 * @returns {object} the receipt.
	 */
	#onServerRequest(method, params) {
		if (method === 'approval/request') this.#onNotification('approval/request', params)
		else if (method === 'userInput/request') this.#onNotification('userInput/requested', params)
		return {}
	}

	/**
	 * Build the panel record out of a full `approval/request` payload.
	 * @param {object} params - `ApprovalRequestParams`.
	 * @returns {object} the stored record.
	 */
	#fullApproval(params) {
		return {
			approvalId: params.approvalId,
			toolName: params.toolName,
			itemId: params.itemId,
			turnId: params.turnId,
			subject: params.subject,
			choices: Array.isArray(params.availableChoices) ? params.availableChoices : [],
			requirementId: params.currentRequirementId,
			rawArgs: params.rawArgs ?? '',
			protectedWrite: params.protectedWrite === true,
			judgeEscalated: params.judgeEscalated === true,
			receivedAt: Date.now()
		}
	}

	/**
	 * Fold a partial `approval/updated` payload into an existing record. Only
	 * the refreshed fields are replaced; the identity fields (`toolName`,
	 * `itemId`, `turnId`, `rawArgs`, the protective flags) stay original.
	 * @param {object} previous - stored record.
	 * @param {object} params - `ApprovalUpdatedParams`.
	 * @returns {object} the merged record.
	 */
	#mergeApproval(previous, params) {
		const merged = { ...previous }
		if (Array.isArray(params.availableChoices)) merged.choices = params.availableChoices
		if (params.currentRequirementId !== undefined) merged.requirementId = params.currentRequirementId
		if (params.subject !== undefined) merged.subject = params.subject
		if (params.change !== undefined) merged.change = params.change
		merged.updatedAt = Date.now()
		return merged
	}

	/**
	 * Recover the pending set after a stream gap: an `approval/updated` can
	 * arrive before any request for it (stream reconnect), so read the
	 * authoritative pending list first. The same list also carries the pending
	 * user-input prompts, which the reconnect backfill has to fold as well or
	 * the panel would show an approval with no question card beside it.
	 *
	 * @param {object} params - the partial `approval/updated` payload.
	 * @returns {Promise<void>} resolves once the merged record is stored.
	 */
	async #backfillPending(params) {
		const sessionId = params.sessionId ?? this.session?.sessionId
		const connection = this.connection
		if (sessionId === undefined || connection === undefined || !connection.alive) return
		try {
			const result = await connection.request('approval/listPending', { sessionId }, { timeoutMs: 15_000 })
			// The list was read through a specific connection; if a restart
			// swapped it out while the request was in flight the answer describes
			// a session this controller no longer owns.
			if (this.connection !== connection) return
			const rows = Array.isArray(result?.approvals) ? result.approvals : []
			for (const row of rows) {
				if (row?.approvalId === undefined || this.approvals.has(row.approvalId)) continue
				const record = this.#fullApproval(row)
				this.approvals.set(row.approvalId, record)
				this.#emit({ type: 'approval', approval: record })
			}
			this.#foldPendingUserInputs(result?.userInputs)
			const base = this.approvals.get(params.approvalId)
			if (base === undefined) {
				// The approval settled before we could read its record: nothing to merge.
				this.logger?.debug?.('muse-code: approval/updated for unknown approval ' + String(params.approvalId))
				return
			}
			const merged = this.#mergeApproval(base, params)
			this.approvals.set(params.approvalId, merged)
			this.#emit({ type: 'approval', approval: merged })
		} catch (error) {
			this.logger?.warn?.('muse-code: approval/listPending failed: ' + String(error?.message ?? error))
		}
	}

	/**
	 * Store the pending user-input prompts from `approval/listPending`.
	 *
	 * `userInputs` is documented as "exactly the `userInput/request` params", so
	 * the record mirrors that payload: every field that is present is copied,
	 * absent optional fields stay absent instead of being invented. Prompts
	 * already stored, and ids that settled before the list came back, are
	 * skipped; the list itself is point-in-time and may repeat a prompt.
	 *
	 * @param {Array<object>} rows - `UserInputRequestParams[]`.
	 */
	#foldPendingUserInputs(rows) {
		if (!Array.isArray(rows)) return
		for (const row of rows) {
			if (row === null || typeof row !== 'object') continue
			const userInputId = row.userInputId
			if (typeof userInputId !== 'string' || userInputId === '') continue
			if (this.questions.has(userInputId)) continue
			if (this.settledQuestions.has(userInputId)) continue
			const record = {
				userInputId,
				questions: Array.isArray(row.questions) ? row.questions : [],
				...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
				...(row.itemId === undefined ? {} : { itemId: row.itemId }),
				...(row.turnId === undefined ? {} : { turnId: row.turnId }),
				...(row.viewCursor === undefined ? {} : { viewCursor: row.viewCursor }),
				receivedAt: Date.now()
			}
			this.questions.set(userInputId, record)
			this.#emit({ type: 'question', question: record })
		}
	}

	/**
	 * Remember that a prompt settled, so a stale pending-list answer cannot
	 * resurrect its card. The memory is bounded; the oldest id is dropped first.
	 * @param {string} userInputId - the settled prompt.
	 */
	#markQuestionSettled(userInputId) {
		this.settledQuestions.add(userInputId)
		if (this.settledQuestions.size <= SETTLED_QUESTION_MEMORY) return
		const oldest = this.settledQuestions.values().next().value
		if (oldest !== undefined) this.settledQuestions.delete(oldest)
	}

	/**
	 * Replace or append one item, honouring the revision rule.
	 * @param {object} item - full item.
	 */
	#upsertItem(item) {
		const existing = this.index.get(item.itemId)
		if (existing !== undefined) {
			if (Number(item.revision ?? 0) < Number(existing.revision ?? 0)) return
			Object.assign(existing, item)
			this.#emit({ type: 'item', item: existing })
			return
		}
		const copy = { ...item }
		this.index.set(item.itemId, copy)
		this.items.push(copy)
		if (this.items.length > MAX_ITEMS) {
			const dropped = this.items.splice(0, this.items.length - MAX_ITEMS)
			for (const gone of dropped) this.index.delete(gone.itemId)
		}
		this.#emit({ type: 'item', item: copy })
	}

	/**
	 * Render the transcript as plain text for a chat tool.
	 * @param {object} [options] - selection.
	 * @param {number} [options.limit] - how many trailing items.
	 * @param {string} [options.kinds] - comma-separated kind filter.
	 * @returns {string} transcript text.
	 */
	transcriptText({ limit = 40, kinds } = {}) {
		const wanted = kinds === undefined || kinds === '' ? undefined : new Set(String(kinds).split(',').map((part) => part.trim()).filter(Boolean))
		const selected = this.items
			.filter((item) => !HIDDEN_KINDS.has(item.kind))
			.filter((item) => wanted === undefined || wanted.has(item.kind))
			.slice(-Math.max(1, Math.min(200, limit)))
		if (selected.length === 0) return '（暂无对话内容）'
		const lines = selected.map((item) => renderItemLine(item)).filter((line) => line !== null)
		return lines.join('\n').slice(0, MAX_TOOL_TEXT)
	}
}

/**
 * One readable transcript line for a chat tool.
 * @param {object} item - MSP item.
 * @returns {string} the line.
 */
export function renderItemLine(item) {
	const status = item.status === 'inProgress' ? '' : ` (${item.status})`
	switch (item.kind) {
		case 'userMessage':
			return `用户: ${String(item.text ?? '')}`
		case 'agentMessage':
			return `Muse${status}: ${String(item.text ?? '')}`
		case 'reasoning':
			return `[思考${status}] ${String(item.text ?? (Array.isArray(item.summary) ? item.summary.join(' / ') : ''))}`.slice(0, 1_200)
		case 'toolCall':
			return `[工具${status}] ${String(item.tool ?? 'tool')}${item.statusLine === undefined ? '' : ' — ' + String(item.statusLine)}${item.visibleOutput === undefined ? '' : '\n' + String(item.visibleOutput).slice(0, 1_500)}`
		case 'userShell':
			return `[终端${status}] $ ${String(item.commandText ?? '')}${item.exitCode === undefined ? '' : ' → exit ' + String(item.exitCode)}${item.visibleOutput === undefined ? '' : '\n' + String(item.visibleOutput).slice(0, 1_500)}`
		case 'compaction':
			return `[上下文压缩${status}]`
		default:
			return `[${String(item.kind)}${status}] ${String(item.fallbackText ?? item.text ?? '')}`.slice(0, 1_000)
	}
}
