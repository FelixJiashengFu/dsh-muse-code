/**
 * Host half of the Muse Code plugin.
 *
 * Responsibilities:
 *  - own the composer switch (persisted under `~/.dsh`), and keep exactly one
 *    `muse serve` child alive while it is on;
 *  - translate the MSP view stream into a small snapshot the browser panel
 *    renders, and push it over a loopback SSE route;
 *  - expose the same operations to chat tools so the model can read the Muse
 *    transcript and drive the session, while approval decisions and answers
 *    stay reachable only from the user's panel.
 *
 * @module dsh-muse-code
 */

import { homedir } from 'node:os'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SpendGuard, DEFAULT_CAP_USD, formatUsd } from './budget.js'
import { MuseController, describeSubject } from './controller.js'
import { MspError, resolveMuseLaunch } from './msp.js'

export const name = 'muse-code'
export const inject = ['tools', 'webServer']

const ROUTE_BASE = '/plugins/dsh-muse-code'
const ROUTES = {
	state: `${ROUTE_BASE}/state`,
	events: `${ROUTE_BASE}/events`,
	enable: `${ROUTE_BASE}/enable`,
	prompt: `${ROUTE_BASE}/prompt`,
	interrupt: `${ROUTE_BASE}/interrupt`,
	approval: `${ROUTE_BASE}/approval`,
	answer: `${ROUTE_BASE}/answer`,
	mode: `${ROUTE_BASE}/mode`,
	options: `${ROUTE_BASE}/options`,
	budget: `${ROUTE_BASE}/budget`,
	sandboxCheck: `${ROUTE_BASE}/sandbox-check`
}

const STATE_DIR = join(homedir(), '.dsh')
const STATE_FILE = join(STATE_DIR, 'muse-code.json')
const SPEND_FILE = join(STATE_DIR, 'muse-code-spend.json')
const MAX_BODY = 64 * 1024

/** Raised when a request body exceeds {@link MAX_BODY}. */
class BodyTooLargeError extends Error {
	constructor() {
		super('请求体超过 64 KiB')
		this.name = 'BodyTooLargeError'
	}
}

/**
 * Normalise an origin so the three loopback spellings a browser may use for the
 * same server (`localhost`, `[::1]`, `127.0.0.1`) compare equal, and drop any
 * trailing slash.
 * @param {string} value - origin or origin-like URL.
 * @returns {string} normalised origin.
 */
function normalizeOrigin(value) {
	return String(value)
		.replace(/\/+$/, '')
		.replace(/\/\/(?:localhost|\[::1\])(?=:|$)/, '//127.0.0.1')
}

/**
 * Decide whether two origins name the same page origin.
 * @param {string} left - first origin.
 * @param {string} right - second origin.
 * @returns {boolean} true when they match.
 */
function sameOrigin(left, right) {
	return normalizeOrigin(left) === normalizeOrigin(right)
}

/** How much of one stream the sandbox probe keeps (head + tail). */
const PROBE_LIMIT_BYTES = 8 * 1024

/** How long `muse sandbox windows check` may run before it is terminated. */
const PROBE_TIMEOUT_MS = 20_000

/**
 * Build the argv for one read-only `muse sandbox windows check` run from the
 * same launch plan the host itself uses, so the probe exercises the exact
 * installed artefact (binary, `muse.cmd` wrapper, or PATH lookup).
 *
 * `resolveMuseLaunch()` already returns the full `serve` argv:
 * `[binary, 'serve']`, `[comspec, '/d', '/s', '/c', '""<wrapper>" serve"']`,
 * or `[comspec, '/d', '/s', '/c', 'muse serve']`. For the two cmd.exe shapes
 * the command string is the LAST element and must be rewritten; the wrapper
 * quoting follows the comment in `resolveMuseLaunch()` (`cmd /s /c` strips one
 * outer quote pair, so the path keeps an extra layer).
 *
 * @param {{argv: string[], kind: string, dir: string}} launch - launch plan.
 * @returns {string[]} argv for `muse sandbox windows check`.
 */
function sandboxCheckArgv(launch) {
	if (launch.kind === 'binary') return [launch.argv[0], 'sandbox', 'windows', 'check']
	const comspec = launch.argv[0]
	if (launch.kind === 'wrapper') {
		const wrapper = join(launch.dir, 'muse.cmd')
		return [comspec, '/d', '/s', '/c', `""${wrapper}" sandbox windows check"`]
	}
	return [comspec, '/d', '/s', '/c', 'muse sandbox windows check']
}

/**
 * The longest prefix of `text` that fits in `maxBytes` UTF-8 bytes.
 *
 * Byte-aware on purpose: the child prints Chinese diagnostics on this machine,
 * and a character-count budget would let one stream exceed 8 KiB threefold.
 * @param {string} text - source text.
 * @param {number} maxBytes - byte budget (0 keeps nothing).
 * @returns {string} prefix (a surrogate pair is cut whole).
 */
function headBytes(text, maxBytes) {
	if (maxBytes <= 0) return ''
	if (Buffer.byteLength(text) <= maxBytes) return text
	let low = 0
	let high = text.length
	while (low < high) {
		const mid = Math.ceil((low + high) / 2)
		if (Buffer.byteLength(text.slice(0, mid)) <= maxBytes) low = mid
		else high = mid - 1
	}
	return text.slice(0, low)
}

/**
 * The longest suffix of `text` that fits in `maxBytes` UTF-8 bytes.
 * @param {string} text - source text.
 * @param {number} maxBytes - byte budget (0 keeps nothing).
 * @returns {string} suffix (a surrogate pair is cut whole).
 */
function tailBytes(text, maxBytes) {
	if (maxBytes <= 0) return ''
	if (Buffer.byteLength(text) <= maxBytes) return text
	let low = 0
	let high = text.length
	while (low < high) {
		const mid = Math.floor((low + high) / 2)
		if (Buffer.byteLength(text.slice(mid)) <= maxBytes) high = mid
		else low = mid + 1
	}
	// Never start on a low surrogate: that half belongs to the previous code point.
	if (low > 0 && /[\uDC00-\uDFFF]/.test(text[low])) return text.slice(low + 1)
	return text.slice(low)
}

/**
 * Keep the head and the tail of one child stream, bounded by a byte budget.
 *
 * The sandbox check prints a diagnostics block whose first lines name the
 * binary and whose last lines carry the verdict, so a plain tail truncation
 * would drop the context and a plain head truncation would drop the result.
 * Both ends are kept, and the elided middle is reported with its byte count.
 */
class OutputCollector {
	/**
	 * @param {number} [limitBytes] - total retained payload, split evenly.
	 */
	constructor(limitBytes = PROBE_LIMIT_BYTES) {
		/** @type {string} first half. */
		this.head = ''
		/** @type {string} last half. */
		this.tail = ''
		this.limit = Math.max(2, limitBytes)
		this.budget = Math.max(1, Math.floor(this.limit / 2))
		/** Total bytes the child printed, including the elided middle. */
		this.bytes = 0
	}

	/**
	 * Append one decoded chunk.
	 * @param {string} chunk - stream text.
	 */
	push(chunk) {
		if (chunk === '') return
		this.bytes += Buffer.byteLength(chunk)
		let rest = chunk
		const headRoom = this.budget - Buffer.byteLength(this.head)
		if (headRoom > 0) {
			const take = headBytes(rest, headRoom)
			this.head += take
			rest = rest.slice(take.length)
		}
		if (rest === '') return
		this.tail = tailBytes(this.tail + rest, this.budget)
	}

	/**
	 * The retained text: whole output when it fits, head + marker + tail when not.
	 * @returns {string} display text.
	 */
	value() {
		const retained = Buffer.byteLength(this.head) + Buffer.byteLength(this.tail)
		if (retained >= this.bytes) return this.head + this.tail
		const omitted = Math.max(0, this.bytes - retained)
		return `${this.head}\n…（中间省略约 ${omitted} 字节）…\n${this.tail}`
	}
}

/**
 * Wait for a child stream to finish flushing after the process exited.
 * @param {object | undefined} stream - readable stream.
 * @param {number} [capMs] - maximum wait.
 * @returns {Promise<void>} resolves on end/close or at the cap.
 */
async function drainStream(stream, capMs = 400) {
	if (stream === undefined || stream === null) return
	if (stream.readableEnded === true || stream.destroyed === true) return
	await new Promise((resolve) => {
		let settled = false
		const finish = () => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve()
		}
		const timer = setTimeout(finish, capMs)
		stream.once?.('end', finish)
		stream.once?.('close', finish)
	})
}


/**
 * Mount the plugin.
 * @param {object} ctx - host plugin context with `tools` and `webServer`.
 */
export function apply(ctx) {
	const logger = ctx.logger
	/** Live SSE responses. */
	const clients = new Set()
	let loading = true
	let busy = false
	/** Resolved once the persisted switch restore has finished (success or not). */
	let markRestored
	const restored = new Promise((resolve) => { markRestored = resolve })
	/** Guards the one-shot unexpected-stop handling. */
	let stopHandled = false
	/** True while a settings change deliberately restarts the host. */
	let restarting = false
	/** True while the plugin itself is unloading. */
	let shuttingDown = false

	/**
	 * Push one event to every connected panel.
	 * @param {object} event - `{type, ...}` payload.
	 */
	function broadcast(event) {
		if (event?.type === 'status' && event.status === 'off' && settings.enabled === true) {
			// The host died (or the session closed) while the switch still says on.
			void handleUnexpectedStop(event.error ?? 'Muse Code 主机已停止')
		}
		const payload = 'data: ' + JSON.stringify(event) + '\n\n'
		for (const res of clients) {
			try {
				res.write(payload)
			} catch {
				clients.delete(res)
			}
		}
	}

	/** @returns {string} the workspace root a Muse session should open in. */
	function resolveWorkspace() {
		try {
			const current = ctx.get('workingDirectory')?.get?.()
			if (typeof current === 'string' && current !== '') return current
		} catch {
			/* service not present */
		}
		return process.cwd()
	}

	/**
	 * Resolve the workspace for one DSH session: the live agent's committed
	 * project directory, so Muse edits the same project the chat is working in.
	 * @param {string} [sessionId] - the DSH session (agent) id that asked.
	 * @returns {Promise<string>} absolute directory.
	 */
	async function resolveWorkspaceFor(sessionId) {
		if (typeof sessionId === 'string' && sessionId !== '') {
			try {
				const agents = ctx.get('agents')
				const directories = ctx.get('workingDirectory')
				const agent = agents?.get?.(sessionId)
				if (agent !== undefined && agent !== null && typeof directories?.ensure === 'function') {
					const directory = await directories.ensure(agent)
					if (typeof directory === 'string' && directory !== '') return directory
				}
			} catch (error) {
				logger?.warn?.('muse-code: could not resolve the session directory: ' + describe(error))
			}
		}
		if (typeof settings.workspace === 'string' && settings.workspace !== '') return settings.workspace
		return resolveWorkspace()
	}

	/**
	 * The spend guard: the one object that knows how much money this plugin's
	 * Muse sessions have cost, reserves the worst-case price of the next call
	 * before it is sent, and latches the hard cap. A guard that cannot be
	 * constructed is recorded as unavailable; the `/budget` route then refuses
	 * to change anything and {@link muse_status} says so explicitly.
	 * @type {SpendGuard | undefined}
	 */
	let budget
	try {
		budget = new SpendGuard({
			capUsd: DEFAULT_CAP_USD,
			stateFile: SPEND_FILE,
			logger
		})
	} catch (error) {
		budget = undefined
		logger?.warn?.('muse-code: spend guard unavailable: ' + describe(error))
	}

	/**
	 * Best human-readable reason the guard is locked.
	 * @returns {string} lock reason (never empty).
	 */
	function budgetLockedReason() {
		const reason = budget?.snapshot?.().lockedReason
		return typeof reason === 'string' && reason !== '' ? reason : '已达到花费上限'
	}

	const controller = new MuseController({
		spawn: (spec) => {
			const subprocess = ctx.get('subprocess')
			if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
				throw new MspError('subprocess 服务不可用，无法启动 Muse Code', -32000)
			}
			return subprocess.spawn(spec)
		},
		logger,
		resolveWorkspace,
		emit: broadcast,
		budget,
		onStopped: (reason) => { void handleUnexpectedStop(reason) }
	})

	/**
	 * Read the persisted switch state.
	 * @returns {Promise<{enabled: boolean, disableSandbox: boolean, workspace?: string}>} persisted settings.
	 */
	async function loadState() {
		try {
			const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'))
			const workspace = typeof parsed?.workspace === 'string' && parsed.workspace !== '' ? parsed.workspace : undefined
			return {
				enabled: parsed?.enabled === true,
				disableSandbox: parsed?.disableSandbox === true,
				workspace
			}
		} catch {
			return { enabled: false, disableSandbox: false, workspace: undefined }
		}
	}

	/**
	 * Persist the switch state, ignoring filesystem failures.
	 * @param {{enabled: boolean, disableSandbox: boolean, workspace?: string}} value - desired settings.
	 */
	async function saveState(value) {
		try {
			await mkdir(STATE_DIR, { recursive: true })
			const tmp = `${STATE_FILE}.tmp`
			const payload = { enabled: value.enabled, disableSandbox: value.disableSandbox }
			if (typeof value.workspace === 'string' && value.workspace !== '') payload.workspace = value.workspace
			await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
			await rename(tmp, STATE_FILE)
		} catch (error) {
			logger?.warn?.('muse-code: could not persist state: ' + describe(error))
		}
	}

	/** Current settings, mirrored into the state file on every change. */
	const settings = { enabled: false, disableSandbox: false, workspace: undefined }

	/**
	 * Wait until the persisted switch has been restored, so a request that
	 * arrives during start-up cannot race the restore (and have its change
	 * overwritten by the restore's own write).
	 * @returns {Promise<void>} resolves once the restore finished, successfully or not.
	 */
	async function waitForRestore() {
		if (loading === false) return
		await restored
	}

	/**
	 * React to the host disappearing without the user turning the switch off:
	 * persist the switch as off and push a fresh snapshot so the panel and the
	 * composer switch follow. Runs at most once per host lifetime, and never
	 * for the deliberate stops of `setEnabled(false)` / a settings restart / an
	 * unload.
	 * @param {string} reason - why the host stopped.
	 */
	async function handleUnexpectedStop(reason) {
		if (stopHandled || shuttingDown || restarting) return
		if (settings.enabled !== true) return
		stopHandled = true
		settings.enabled = false
		controller.enabled = false
		logger?.warn?.('muse-code: host stopped unexpectedly: ' + String(reason))
		await saveState(settings)
		broadcast({ type: 'snapshot', snapshot: controller.snapshot() })
	}

	/**
	 * Flip the switch.
	 * @param {boolean} next - desired state.
	 * @param {string} [sessionId] - the DSH session whose project Muse should open in.
	 * @returns {Promise<object>} the snapshot actually in force.
	 */
	async function setEnabled(next, sessionId) {
		await waitForRestore()
		// A locked guard means every further model call could cross the cap, so
		// turning the switch (or reopening the panel) is refused until the user
		// raises the cap or resets the ledger from the panel.
		if (next && budget?.locked === true) {
			throw new MspError(`花费上限已锁定：${budgetLockedReason()}。请在面板里提高上限或重置花费记录后再打开。`, -32000)
		}
		if (busy) throw new MspError('开关正在切换，请稍候', -32000)
		if (next === settings.enabled && (next === false || controller.session !== undefined)) {
			// Already on: the caller still wants the panel in front of the user.
			if (next) broadcast({ type: 'open-panel' })
			return controller.snapshot()
		}
		busy = true
		try {
			if (next) {
				if (controller.session === undefined) {
					controller.workspaceOverride = await resolveWorkspaceFor(sessionId)
					settings.workspace = controller.workspaceOverride
				}
				controller.disableSandbox = settings.disableSandbox
				// Re-check after the awaited workspace resolution: the guard may
				// have latched in the meantime (a concurrent usage event), and a
				// second start must not slip past the cap.
				if (budget?.locked === true) {
					throw new MspError(`花费上限已锁定：${budgetLockedReason()}。请在面板里提高上限或重置花费记录后再打开。`, -32000)
				}
				await controller.start()
				settings.enabled = true
				stopHandled = false
				await saveState(settings)
				broadcast({ type: 'enabled', enabled: true })
				broadcast({ type: 'open-panel' })
				return controller.snapshot()
			}
			settings.enabled = false
			await controller.stop()
			await saveState(settings)
			broadcast({ type: 'enabled', enabled: false })
			return controller.snapshot()
		} finally {
			busy = false
		}
	}

	/**
	 * Turn Muse's unsandboxed mode on or off — user-only, never reachable from a
	 * model tool. The switch is persisted and applied by restarting the host.
	 * @param {boolean} next - desired value.
	 * @returns {Promise<object>} the resulting snapshot.
	 */
	async function setDisableSandbox(next) {
		await waitForRestore()
		if (busy) throw new MspError('开关正在切换，请稍候', -32000)
		if (next === settings.disableSandbox) return controller.snapshot()
		busy = true
		restarting = true
		try {
			settings.disableSandbox = next
			await saveState(settings)
			controller.disableSandbox = next
			if (settings.enabled) {
				try {
					await controller.stop()
					await controller.start()
					stopHandled = false
				} catch (error) {
					// The restart failed: report the switch as off instead of leaving
					// a "on" switch in front of a dead host.
					settings.enabled = false
					await saveState(settings)
					broadcast({ type: 'snapshot', snapshot: controller.snapshot() })
					broadcast({ type: 'enabled', enabled: false })
					throw error
				}
			}
			broadcast({ type: 'snapshot', snapshot: controller.snapshot() })
			return controller.snapshot()
		} finally {
			restarting = false
			busy = false
		}
	}

	// ── HTTP surface for the browser half ──────────────────────────────────

	/**
	 * Serialise a JSON reply.
	 * @param {object} res - node response.
	 * @param {number} status - HTTP status.
	 * @param {object} body - payload.
	 */
	function sendJson(res, status, body) {
		const payload = JSON.stringify(body)
		res.writeHead(status, {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			'content-length': Buffer.byteLength(payload)
		})
		res.end(payload)
	}

	/**
	 * Read and decode a small JSON request body.
	 * @param {object} req - node request.
	 * @returns {Promise<object>} decoded body.
	 */
	async function readJson(req) {
		const chunks = []
		let size = 0
		for await (const chunk of req) {
			size += chunk.length
			if (size > MAX_BODY) throw new BodyTooLargeError()
			chunks.push(chunk)
		}
		if (size === 0) return {}
		try {
			return JSON.parse(Buffer.concat(chunks).toString('utf8'))
		} catch {
			throw new MspError('请求体不是合法 JSON', -32600)
		}
	}

	/** @param {object} req - node request. @returns {boolean} loopback only. */
	function isLoopback(req) {
		const address = req.socket?.remoteAddress ?? ''
		return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
	}

	/**
	 * Reject a request that did not originate from this Harness page.
	 *
	 * Every route is loopback-only; on top of that the browser's own fetch adds
	 * `Origin` on non-GET requests and `Sec-Fetch-Site` on every request, and the
	 * panel proves itself with `x-muse-code: 1`. Together these stop a stray page
	 * on another local port (or any other local process) from driving Muse.
	 * Refusals are written here, so a caller only has to return on `false`.
	 *
	 * @param {object} req - node request.
	 * @param {object} res - node response.
	 * @param {'GET' | 'POST'} method - the method this route expects.
	 * @returns {boolean} true when the request may proceed.
	 */
	function guard(req, res, method) {
		if (!isLoopback(req)) {
			sendJson(res, 403, { ok: false, error: 'loopback only' })
			return false
		}
		if (req.method !== method) {
			sendJson(res, 405, { ok: false, error: 'method not allowed' })
			return false
		}
		const site = String(req.headers['sec-fetch-site'] ?? '')
		if (site === 'cross-site') {
			sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
			return false
		}
		const origin = req.headers.origin
		if (typeof origin === 'string' && origin !== '') {
			let expected
			try {
				const value = ctx.get('webServer')?.getOrigin?.()
				expected = typeof value === 'string' ? value.replace(/\/+$/, '') : undefined
			} catch {
				expected = undefined
			}
			if (expected === undefined) {
				// Unknown origin shape (or an unexpected return type): fall back to a
				// plain same-origin test — a browser's Origin authority equals Host.
				try {
					const parsed = new URL(origin)
					expected = `${parsed.protocol}//${req.headers.host ?? parsed.host}`
				} catch {
					expected = undefined
				}
			}
			if (typeof expected === 'string' && expected !== '' && !sameOrigin(origin, expected)) {
				sendJson(res, 403, { ok: false, error: 'origin refused' })
				return false
			}
		}
		if (method === 'POST') {
			const type = String(req.headers['content-type'] ?? '').toLowerCase()
			if (!type.startsWith('application/json')) {
				sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
				return false
			}
			if (req.headers['x-muse-code'] !== '1') {
				sendJson(res, 403, { ok: false, error: 'missing x-muse-code header' })
				return false
			}
		}
		return true
	}

	/**
	 * Send the one JSON failure shape for a caught error.
	 *
	 * A request body over {@link MAX_BODY} gets its 413 written first and the
	 * request destroyed afterwards, because the client may still be uploading.
	 * Anything else maps to 400 when the failure came from the request itself
	 * (`MspError` -32600) and to 500 otherwise.
	 *
	 * @param {object} req - node request.
	 * @param {object} res - node response.
	 * @param {unknown} error - caught value.
	 * @param {object} [extra] - extra fields merged into the body.
	 */
	function sendFailure(req, res, error, extra) {
		if (error instanceof BodyTooLargeError) {
			const payload = JSON.stringify({ ok: false, error: describe(error) })
			res.writeHead(413, {
				'content-type': 'application/json; charset=utf-8',
				'cache-control': 'no-store',
				'content-length': Buffer.byteLength(payload)
			})
			res.end(payload, () => {
				try { req.destroy() } catch { /* already gone */ }
			})
			return
		}
		const status = error instanceof MspError && error.code === -32600 ? 400 : 500
		sendJson(res, status, { ok: false, error: describe(error), ...(extra ?? {}) })
	}

	/** True while one read-only sandbox probe owns the subprocess slot. */
	let sandboxCheckRunning = false

	/**
	 * Run one read-only `muse sandbox windows check`.
	 *
	 * This deliberately spawns a throwaway process instead of asking the live
	 * `muse serve` host: the check validates the installed artefacts
	 * (`backend`, `runner_trusted`, `sandbox_users_ready`, `wfp_ready`, …),
	 * while `serve` makes its own runtime availability decision on
	 * `initialize`. The two can disagree — that is exactly what the panel
	 * explains next to the output — and the probe must never disturb the
	 * session, the switch, or any persisted state.
	 *
	 * @returns {Promise<object>} `{ kind, version, command, exitCode, signal, passed, durationMs, stdout, stderr }`.
	 */
	async function runSandboxCheck() {
		const subprocess = ctx.get('subprocess')
		if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
			throw new MspError('subprocess 服务不可用，无法运行 muse sandbox 检测', -32000)
		}
		const launch = resolveMuseLaunch()
		const argv = sandboxCheckArgv(launch)
		const startedAt = Date.now()
		const handle = subprocess.spawn({
			argv,
			cwd: homedir(),
			stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
			graceMs: 5_000
		})
		const out = new OutputCollector()
		const err = new OutputCollector()
		try {
			handle.stdout?.setEncoding?.('utf8')
			handle.stderr?.setEncoding?.('utf8')
		} catch {
			/* a provider may hand back a non-text stream; String() still works */
		}
		handle.stdout?.on?.('data', (chunk) => out.push(String(chunk)))
		handle.stderr?.on?.('data', (chunk) => err.push(String(chunk)))

		let timedOut = false
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		let timer
		const deadline = new Promise((resolve) => {
			timer = setTimeout(() => {
				timedOut = true
				resolve(undefined)
			}, PROBE_TIMEOUT_MS)
		})
		let outcome
		try {
			outcome = await Promise.race([
				Promise.resolve(handle.done).catch((error) => ({ failure: error })),
				deadline
			])
		} finally {
			clearTimeout(timer)
		}
		if (timedOut) {
			try {
				handle.terminate?.()
			} catch {
				/* already gone */
			}
			await drainStream(handle.stdout)
			await drainStream(handle.stderr)
			throw new MspError(`超时：muse sandbox windows check 未在 ${Math.round(PROBE_TIMEOUT_MS / 1000)} 秒内结束，已终止`, -32001)
		}
		// A process can report its exit before the last stdout chunk reaches us.
		await drainStream(handle.stdout)
		await drainStream(handle.stderr)
		if (outcome?.failure !== undefined) throw outcome.failure
		const exitCode = typeof outcome?.exitCode === 'number' ? outcome.exitCode : null
		return {
			kind: launch.kind,
			version: launch.version,
			command: argv.join(' '),
			exitCode,
			signal: outcome?.signal ?? null,
			passed: exitCode === 0,
			durationMs: Date.now() - startedAt,
			stdout: out.value(),
			stderr: err.value()
		}
	}

	ctx.inject(['webServer'], (webCtx) => {
		webCtx.effect(() => webCtx.webServer.register({
			kind: 'exact',
			path: ROUTES.state,
			async handler(req, res) {
				if (!guard(req, res, 'GET')) return
				sendJson(res, 200, { ok: true, loading, busy, snapshot: controller.snapshot() })
			}
		}), 'muse-code state route')

		webCtx.effect(() => webCtx.webServer.register({
			kind: 'exact',
			path: ROUTES.events,
			handler(req, res) {
				if (!guard(req, res, 'GET')) return
				res.writeHead(200, {
					'content-type': 'text/event-stream; charset=utf-8',
					'cache-control': 'no-store, no-transform',
					connection: 'keep-alive',
					'x-accel-buffering': 'no'
				})
				res.write(': muse-code\n\n')
				clients.add(res)
				const write = (event) => { res.write('data: ' + JSON.stringify(event) + '\n\n') }
				write({ type: 'snapshot', snapshot: controller.snapshot() })
				const keepAlive = setInterval(() => {
					try { res.write(': ping\n\n') } catch { /* closed */ }
				}, 15_000)
				const drop = () => {
					clearInterval(keepAlive)
					clients.delete(res)
				}
				req.on('close', drop)
				res.on('close', drop)
			}
		}), 'muse-code events route')

		webCtx.effect(() => webCtx.webServer.register({
			kind: 'exact',
			path: ROUTES.enable,
			async handler(req, res) {
				if (!guard(req, res, 'POST')) return
				try {
					const body = await readJson(req)
					if (typeof body.enabled !== 'boolean') { sendJson(res, 400, { ok: false, error: 'enabled must be a boolean' }); return }
					const snapshot = await setEnabled(body.enabled, typeof body.sessionId === 'string' ? body.sessionId : undefined)
					sendJson(res, 200, { ok: true, snapshot })
				} catch (error) {
					sendFailure(req, res, error, { snapshot: controller.snapshot() })
				}
			}
		}), 'muse-code enable route')

		webCtx.effect(() => webCtx.webServer.register({
			kind: 'exact',
			path: ROUTES.prompt,
			async handler(req, res) {
				if (!guard(req, res, 'POST')) return
				try {
					const body = await readJson(req)
					const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
					if (settings.enabled !== true || controller.session === undefined) {
						await setEnabled(true, sessionId)
					}
					const ack = await controller.prompt(String(body.text ?? ''), { steer: body.steer === true })
					sendJson(res, 200, { ok: true, ack })
				} catch (error) {
					sendFailure(req, res, error)
				}
			}
		}), 'muse-code prompt route')

		webCtx.effect(() => webCtx.webServer.register({
			kind: 'exact',
			path: ROUTES.interrupt,
			async handler(req, res) {
				if (!guard(req, res, 'POST')) return
				try {
					const ack = await controller.interrupt()
					sendJson(res, 200, { ok: true, ack })
				} catch (error) {
					sendFailure(req, res, error)
				}
			}
		}), 'muse-code interrupt route')

		webCtx.effect(() => webCtx.webServer.register({
			kind: 'exact',
			path: ROUTES.approval,
			async handler(req, res) {
				if (!guard(req, res, 'POST')) return
				try {
					const body = await readJson(req)
					const ack = await controller.decide({
						approvalId: String(body.approvalId ?? ''),
						choiceId: String(body.choiceId ?? ''),
						requirementId: body.requirementId ?? body.currentRequirementId,
						feedback: body.feedback
					})
					sendJson(res, 200, { ok: true, ack })
				} catch (error) {
					sendFailure(req, res, error)
				}
			}
		}), 'muse-code approval route')

		webCtx.effect(() => webCtx.webServer.register({
			kind: 'exact',
			path: ROUTES.answer,
			async handler(req, res) {
				if (!guard(req, res, 'POST')) return
				try {
					const body = await readJson(req)
					const ack = await controller.answer({
						userInputId: String(body.userInputId ?? ''),
						answers: Array.isArray(body.answers) ? body.answers : []
					})
					sendJson(res, 200, { ok: true, ack })
				} catch (error) {
					sendFailure(req, res, error)
				}
			}
		}), 'muse-code answer route')

		webCtx.effect(() => webCtx.webServer.register({
			kind: 'exact',
			path: ROUTES.mode,
			async handler(req, res) {
				if (!guard(req, res, 'POST')) return
				try {
					const body = await readJson(req)
					const ack = await controller.setApprovalMode(String(body.mode ?? 'onRequest'))
					sendJson(res, 200, { ok: true, ack })
				} catch (error) {
					sendFailure(req, res, error)
				}
			}
		}), 'muse-code mode route')

		webCtx.effect(() => webCtx.webServer.register({
			kind: 'exact',
			path: ROUTES.options,
			async handler(req, res) {
				if (!guard(req, res, 'POST')) return
				try {
					const body = await readJson(req)
					if (typeof body.disableSandbox !== 'boolean') { sendJson(res, 400, { ok: false, error: 'disableSandbox must be a boolean' }); return }
					const snapshot = await setDisableSandbox(body.disableSandbox)
					sendJson(res, 200, { ok: true, snapshot })
				} catch (error) {
					sendFailure(req, res, error, { snapshot: controller.snapshot() })
				}
			}
		}), 'muse-code options route')

		// Read-only sandbox diagnostics. The user clicked a button in the panel;
		// nothing here touches the Muse session, the switch or the state file.
		webCtx.effect(() => webCtx.webServer.register({
			kind: 'exact',
			path: ROUTES.sandboxCheck,
			async handler(req, res) {
				if (!guard(req, res, 'POST')) return
				if (sandboxCheckRunning) {
					sendJson(res, 409, { ok: false, error: '已有一次沙箱检测正在进行，请等它结束' })
					return
				}
				sandboxCheckRunning = true
				try {
					// Drain the (empty) JSON body so a malformed request fails
					// before a process is spawned, and a keep-alive connection
					// never stalls with an unread body.
					await readJson(req)
					const result = await runSandboxCheck()
					sendJson(res, 200, { ok: true, ...result })
				} catch (error) {
					sendFailure(req, res, error)
				} finally {
					sandboxCheckRunning = false
				}
			}
		}), 'muse-code sandbox-check route')

		// One route per path: the web server rejects a duplicate `(kind, path)`
		// pair, so the spend guard's read and its two mutations share one exact
		// route and are split on the method (the same shape the host itself
		// uses). GET is read-only; POST is guarded like every other mutation,
		// including `x-muse-code: 1`.
		webCtx.effect(() => webCtx.webServer.register({
			kind: 'exact',
			path: ROUTES.budget,
			async handler(req, res) {
				if (req.method === 'POST') {
					if (!guard(req, res, 'POST')) return
					try {
						if (budget === undefined) throw new MspError('花费护栏不可用', -32000)
						const body = await readJson(req)
						if (body.action === 'set-cap') {
							const capUsd = Number(body.capUsd)
							if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > 100000) {
								throw new MspError('上限必须是 0 到 100000 之间的数字', -32600)
							}
							budget.setCap(capUsd)
						} else if (body.action === 'reset') {
							if (body.confirm !== true) throw new MspError('重置需要 confirm: true', -32600)
							budget.reset()
						} else {
							throw new MspError('未知的 budget action', -32600)
						}
						const budgetSnapshot = budget.snapshot()
						broadcast({ type: 'budget', budget: budgetSnapshot })
						broadcast({ type: 'snapshot', snapshot: controller.snapshot() })
						sendJson(res, 200, { ok: true, budget: budgetSnapshot })
					} catch (error) {
						sendFailure(req, res, error)
					}
					return
				}
				if (!guard(req, res, 'GET')) return
				sendJson(res, 200, { ok: true, budget: budget === undefined ? null : budget.snapshot() })
			}
		}), 'muse-code budget route')
	})

	// ── model-facing tools ──────────────────────────────────────────────────

	/**
	 * Refuse a Muse operation while the switch is off.
	 * @returns {MuseController} the controller.
	 */
	function requireEnabled() {
		if (!settings.enabled || controller.session === undefined) {
			throw new MspError('Muse Code 当前是关闭状态：请让用户在输入框左侧打开「Muse Code」开关，或先调用 muse_open。', -32000)
		}
		return controller
	}

	const textOutput = {
		schema: {
			type: 'object',
			additionalProperties: false,
			required: ['text'],
			properties: { text: { type: 'string', description: '要展示给模型的文本。' } }
		},
		render: (_args, value) => [{ type: 'text', text: String(value.text).slice(0, 24_000) }]
	}

	const disposers = []

	/**
	 * Register one tool and remember its disposer.
	 * @param {object} definition - normalized tool definition.
	 */
	function addTool(definition) {
		const disposable = ctx.tools.register(definition)
		if (typeof disposable === 'function') disposers.push(disposable)
		else if (disposable !== undefined && disposable !== null && typeof disposable.dispose === 'function') disposers.push(() => disposable.dispose())
	}

	ctx.effect(() => {
		addTool({
			name: 'muse_open',
			description: '打开 Muse Code：启动（或复用）一个 Muse Code 会话，并在右侧边栏显示实时面板。用户点击开关时做的是同一件事。',
			parameters: { type: 'object', additionalProperties: false, properties: {} },
			output: textOutput,
			async execute(_args, exec) {
				const snapshot = await setEnabled(true, exec?.agent?.id)
				return { text: `Muse Code 已打开。\n会话: ${snapshot.session?.sessionId ?? '(无)'}\n模型: ${snapshot.session?.modelId ?? '(未知)'}\n工作区: ${snapshot.session?.workspaceRoot ?? resolveWorkspace()}\n审批模式: ${snapshot.session?.approvalMode ?? 'onRequest'}\n面板：右侧边栏「Muse Code」。` }
			}
		})

		addTool({
			name: 'muse_status',
			description: '查看 Muse Code 的状态：开关、会话、当前回合、上下文用量、待审批与待回答的问题。审批和回答只能由用户在面板里操作，本工具只读。',
			parameters: { type: 'object', additionalProperties: false, properties: {} },
			output: textOutput,
			async execute() {
				const snapshot = controller.snapshot()
				const spend = budget === undefined ? undefined : budget.snapshot()
				const lines = [
					`开关: ${snapshot.enabled ? '开' : '关'}`,
					`状态: ${snapshot.status}`,
					`会话: ${snapshot.session?.sessionId ?? '(无)'}`,
					`模型: ${snapshot.session?.modelId ?? '(未知)'} / provider ${snapshot.session?.providerId ?? '?'}`,
					`工作区: ${snapshot.session?.workspaceRoot ?? resolveWorkspace()}`,
					`审批模式: ${snapshot.session?.approvalMode ?? '?'}`,
					`当前回合: ${snapshot.lastTurn === null ? '(尚未运行)' : `${snapshot.lastTurn.turnId} → ${snapshot.lastTurn.terminal ?? 'running'}`}`,
					`上下文: ${snapshot.usage === null ? '(未知)' : `${snapshot.usage.usedTokens}/${snapshot.usage.windowTokens ?? '?'} tokens (${snapshot.usage.pressure})`}`,
					`花费: ${spend === undefined ? '(不可用)' : `${formatUsd(spend.spentUsd)} / ${formatUsd(spend.capUsd)}（剩余 ${formatUsd(spend.remainingUsd)}，下次调用预留 ${formatUsd(spend.reservedUsd)}）`}`,
					`沙箱: ${snapshot.host === null ? '(尚未启动)' : snapshot.host.sandbox === 'available' ? '可用' : `不可用${snapshot.host.sandboxReason === null ? '' : ` (${snapshot.host.sandboxReason})`}`}`,
					`无沙箱模式: ${snapshot.disableSandbox ? '已开启（危险，仅用户可在面板切换）' : '关闭'}`
				]
				if (snapshot.host !== null && snapshot.host.sandbox !== 'available' && !snapshot.disableSandbox) {
					lines.push('注意: Muse 在本机无法启用沙箱，shell 工具会失败。用户在面板里可以点「检测沙箱」运行只读的 `muse sandbox windows check`，开启「无沙箱模式」，或先运行 `muse sandbox windows setup` 修复。')
				}
				if (snapshot.lastError !== null) lines.push(`最近错误: ${snapshot.lastError}`)
				if (spend !== undefined && spend.locked === true) lines.push(`花费锁定: ${spend.lockedReason ?? '已达到花费上限'}`)
				if (snapshot.approvals.length > 0) {
					lines.push(`待审批 ${snapshot.approvals.length} 条（只能由用户在面板里决定）:`)
					for (const approval of snapshot.approvals) lines.push(`- ${approval.toolName}: ${describeSubject(approval.subject)}`)
				}
				if (snapshot.questions.length > 0) {
					lines.push(`待回答 ${snapshot.questions.length} 条（只能由用户在面板里回答）:`)
					for (const question of snapshot.questions) {
						for (const item of question.questions) lines.push(`- ${item.header ?? ''} ${item.question}`.trim())
					}
				}
				return { text: lines.join('\n') }
			}
		})

		addTool({
			name: 'muse_prompt',
			description: '把一条任务发给 Muse Code 会话并开始一个新回合。同一个会话会实时同步到右侧边栏面板；用 muse_read 读取它返回的内容。',
			parameters: {
				type: 'object',
				additionalProperties: false,
				required: ['text'],
				properties: {
					text: { type: 'string', description: '发给 Muse Code 的完整任务描述。' },
					steer: { type: 'boolean', description: '为 true 时把内容插入正在运行的回合（steer），而不是排队等下一个回合。' }
				}
			},
			output: textOutput,
			async execute(args) {
				const live = requireEnabled()
				const ack = await live.prompt(String(args.text ?? ''), { steer: args.steer === true })
				return { text: `已提交给 Muse Code。\ncommandId: ${ack.commandId}\nturnId: ${ack.turnId}\ndisposition: ${ack.disposition}\n\n用 muse_read 查看 Muse 的回复（面板会自动刷新）。` }
			}
		})

		addTool({
			name: 'muse_read',
			description: '读取 Muse Code 会话最近的对话：用户消息、Muse 回复、工具调用、终端输出。用于在聊天里跟进 Muse 的进展。',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					limit: { type: 'number', description: '返回最后多少条，默认 40，最多 200。' },
					kinds: { type: 'string', description: '可选，只看这些类型，逗号分隔：userMessage,agentMessage,toolCall,userShell,reasoning。' }
				}
			},
			output: textOutput,
			async execute(args) {
				const live = requireEnabled()
				const status = live.status === 'running' ? '（Muse 正在运行）' : '（Muse 空闲）'
				return { text: `${status}\n` + live.transcriptText({ limit: Number(args.limit ?? 40), kinds: args.kinds }) }
			}
		})

		addTool({
			name: 'muse_interrupt',
			description: '打断 Muse Code 当前正在运行的回合（相当于在面板里点停止）。',
			parameters: { type: 'object', additionalProperties: false, properties: {} },
			output: textOutput,
			async execute() {
				const live = requireEnabled()
				const ack = await live.interrupt()
				return { text: `已发送打断请求。\nturnId: ${ack.turnId}\nstatus: ${ack.status}` }
			}
		})

		return () => {
			for (let index = disposers.length - 1; index >= 0; index -= 1) {
				try { disposers[index]() } catch { /* already gone */ }
			}
			disposers.length = 0
		}
	}, 'muse-code tools')

	ctx.effect(() => async () => {
		shuttingDown = true
		await controller.stop()
		for (const res of clients) {
			try { res.end() } catch { /* closed */ }
		}
		clients.clear()
	}, 'muse-code shutdown')

	// Restore the switch after a restart, without blocking plugin start-up.
	// Requests that arrive while this runs wait for `restored` (see
	// `waitForRestore`), so the persisted value can never overwrite a change the
	// user made in the meantime.
	void loadState().then(async (persisted) => {
		settings.enabled = persisted.enabled
		settings.disableSandbox = persisted.disableSandbox
		settings.workspace = persisted.workspace
		controller.disableSandbox = persisted.disableSandbox
		if (persisted.enabled && budget?.locked === true) {
			// A restart must not resurrect a session that already burned through
			// the cap: keep the switch off and push the locked snapshot so the
			// panel shows the lock and its unlock controls.
			settings.enabled = false
			await saveState(settings)
			logger?.warn?.('muse-code: spend cap locked; not restarting')
			broadcast({ type: 'snapshot', snapshot: controller.snapshot() })
			return
		}
		if (persisted.enabled) {
			try {
				settings.enabled = true
				if (controller.session === undefined) {
					controller.workspaceOverride = await resolveWorkspaceFor(undefined)
				}
				await controller.start()
				stopHandled = false
				logger?.info?.('muse-code: restored enabled state')
			} catch (error) {
				settings.enabled = false
				logger?.warn?.('muse-code: could not restore enabled state: ' + describe(error))
			}
		}
	}).finally(() => {
		loading = false
		markRestored()
	})
}

/**
 * Turn anything into a short message.
 * @param {unknown} error - caught value.
 * @returns {string} message text.
 */
function describe(error) {
	return error instanceof Error ? error.message : String(error)
}
