/**
 * The MSP (Muse Session Protocol) wire: NDJSON JSON-RPC 2.0 over a child
 * process' stdio.
 *
 * `muse serve` owns stdin/stdout, speaks one JSON object per line, and requires
 * the LSP-style `initialize` request followed by the `initialized`
 * notification before any session command is accepted. Everything below is
 * transport only: it knows nothing about transcripts, approvals or the panel.
 *
 * @module dsh-muse-code/msp
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomFillSync } from 'node:crypto'

/** Largest single wire line we are willing to parse. */
const MAX_LINE = 8 * 1024 * 1024

/**
 * A UUIDv7: the 48-bit millisecond timestamp first, then random bits, with the
 * version and variant nibbles stamped in. MSP command ids must be v7.
 * @returns {string} the canonical 36-character uuid.
 */
export function uuidv7() {
	const bytes = Buffer.alloc(16)
	let ms = BigInt(Date.now())
	for (let index = 5; index >= 0; index -= 1) {
		bytes[index] = Number(ms & 0xffn)
		ms >>= 8n
	}
	randomFillSync(bytes, 6)
	bytes[6] = (bytes[6] & 0x0f) | 0x70
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	const hex = bytes.toString('hex')
	return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20)
}

/**
 * Locate the locally installed Muse Code host.
 *
 * The launcher script (`.muse-launcher.ps1`, reached through `muse.cmd`) runs
 * an update check and then `&`s a ~500 MB binary. For a long-lived `serve`
 * child we skip that path and exec the versioned binary directly; the launcher
 * stays the fallback.
 *
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @returns {{ argv: string[], dir: string, version: string, kind: string }} launch plan.
 */
export function resolveMuseLaunch(env = process.env) {
	const localAppData = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
	const dir = env.MUSE_INSTALL_DIR || join(localAppData, 'Programs', 'muse')
	let version = ''
	try {
		version = readFileSync(join(dir, '.muse-version'), 'utf8').trim().split(/\r?\n/)[0].trim()
	} catch {
		version = ''
	}
	const binary = version === '' ? '' : join(dir, `muse-bin-${version}.exe`)
	if (binary !== '' && existsSync(binary)) {
		return { argv: [binary, 'serve'], dir, version, kind: 'binary' }
	}
	const wrapper = join(dir, 'muse.cmd')
	const comspec = env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
	if (existsSync(wrapper)) {
		// cmd.exe /s /c strips the outermost quote pair, so a quoted path needs one
		// extra layer: `cmd /c ""C:\dir with space\muse.cmd" serve"`.
		return { argv: [comspec, '/d', '/s', '/c', `""${wrapper}" serve"`], dir, version, kind: 'wrapper' }
	}
	return { argv: [comspec, '/d', '/s', '/c', 'muse serve'], dir, version, kind: 'path' }
}

/**
 * A JSON-RPC failure surfaced with the protocol's own code and kind.
 */
export class MspError extends Error {
	/**
	 * @param {string} message - server text.
	 * @param {number} [code] - JSON-RPC code.
	 * @param {unknown} [data] - server error data.
	 */
	constructor(message, code, data) {
		super(message)
		this.name = 'MspError'
		this.code = code
		this.data = data
	}
}

/**
 * One live connection to a `muse serve` child.
 */
export class MspConnection {
	/**
	 * @param {object} options - transport wiring.
	 * @param {(spec: object) => object} options.spawn - `ctx.subprocess.spawn`.
	 * @param {string} options.cwd - working directory for the child.
	 * @param {string[]} options.argv - executable plus fixed arguments.
	 * @param {Record<string, string | undefined>} [options.env] - child environment.
	 * @param {object} [options.logger] - host logger.
	 * @param {(method: string, params: object) => void} [options.onNotification] - server notifications.
	 * @param {(method: string, params: object) => object} [options.onServerRequest] - server requests; return the result payload.
	 * @param {(code: number | null) => void} [options.onExit] - child exited.
	 */
	constructor({ spawn, cwd, argv, env, logger, onNotification, onServerRequest, onExit }) {
		this.spawn = spawn
		this.cwd = cwd
		this.argv = argv
		this.env = env
		this.logger = logger
		this.onNotification = onNotification ?? (() => {})
		this.onServerRequest = onServerRequest ?? (() => ({}))
		this.onExit = onExit ?? (() => {})
		this.handle = undefined
		this.pending = new Map()
		this.nextId = 1
		this.buffer = ''
		this.closed = false
		this.ready = false
		/** @type {((chunk: unknown) => void) | undefined} */
		this.onStdout = undefined
		/** @type {((chunk: unknown) => void) | undefined} */
		this.onStderr = undefined
	}

	/** @returns {boolean} whether the handshake completed. */
	get alive() {
		return this.ready && this.closed === false
	}

	/**
	 * Spawn the child and complete the MSP handshake.
	 * @param {object} [initOptions] - handshake knobs.
	 * @param {string} [initOptions.clientName] - machine identifier matching `^[a-z0-9_]+$`.
	 * @param {number} [initOptions.timeoutMs] - handshake deadline.
	 * @returns {Promise<object>} the `initialize` result.
	 */
	async connect({ clientName = 'dsh_muse_code', timeoutMs = 60_000 } = {}) {
		const handle = this.spawn({
			argv: this.argv,
			cwd: this.cwd,
			stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
			graceMs: 5_000,
			env: this.env
		})
		this.handle = handle

		handle.stdout?.setEncoding?.('utf8')
		this.onStdout = (chunk) => this.#ingest(String(chunk))
		handle.stdout?.on?.('data', this.onStdout)
		handle.stderr?.setEncoding?.('utf8')
		this.onStderr = (chunk) => {
			const text = String(chunk).trim()
			if (text !== '') this.logger?.debug?.('muse-code: stderr ' + text.slice(0, 400))
		}
		handle.stderr?.on?.('data', this.onStderr)
		handle.done.then((result) => {
			this.closed = true
			this.ready = false
			this.#releaseListeners()
			for (const [, entry] of this.pending) {
				clearTimeout(entry.timer)
				entry.reject(new MspError('Muse Code host exited (code ' + String(result?.exitCode) + ')', -32000, result))
			}
			this.pending.clear()
			this.onExit(result?.exitCode ?? null)
		}).catch(() => {})

		const result = await this.request('initialize', {
			clientInfo: { name: clientName, version: '0.1.0' }
		}, { timeoutMs })
		this.notify('initialized')
		this.ready = true
		return result
	}

	/**
	 * Send a request and await its response.
	 * @param {string} method - protocol method.
	 * @param {object} [params] - method params.
	 * @param {object} [options] - deadline.
	 * @param {number} [options.timeoutMs] - how long to wait.
	 * @returns {Promise<any>} the result payload.
	 */
	request(method, params, { timeoutMs = 120_000 } = {}) {
		if (this.handle === undefined || this.closed) {
			return Promise.reject(new MspError('Muse Code host is not running', -32000))
		}
		const id = this.nextId
		this.nextId += 1
		const frame = { jsonrpc: '2.0', id, method }
		if (params !== undefined) frame.params = params
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new MspError(`Muse Code did not answer ${method} in ${timeoutMs} ms`, -32001))
			}, timeoutMs)
			this.pending.set(id, { resolve, reject, timer, method })
			this.#write(frame)
		})
	}

	/**
	 * Send a notification.
	 * @param {string} method - protocol method.
	 * @param {object} [params] - method params.
	 */
	notify(method, params) {
		const frame = { jsonrpc: '2.0', method }
		if (params !== undefined) frame.params = params
		this.#write(frame)
	}

	/**
	 * Answer a server-initiated request.
	 * @param {number | string} id - the request id.
	 * @param {object} result - receipt payload.
	 */
	respond(id, result) {
		this.#write({ jsonrpc: '2.0', id, result })
	}

	/**
	 * Fail a server-initiated request.
	 * @param {number | string} id - the request id.
	 * @param {number} code - JSON-RPC error code.
	 * @param {string} message - error text.
	 */
	respondError(id, code, message) {
		this.#write({ jsonrpc: '2.0', id, error: { code, message } })
	}

	/**
	 * Detach from the child without waiting for it to exit.
	 *
	 * The controller calls this when it drops a connection (before a restart, on
	 * teardown, or on a user stop). After detaching, nothing the old child says
	 * can reach the controller: pending requests are rejected once, the stream
	 * listeners are removed, and every callback becomes a no-op. Detaching twice
	 * is harmless. The child itself is not killed here; `stop()` handles that.
	 */
	detach() {
		this.closed = true
		this.ready = false
		this.#releaseListeners()
		this.onNotification = () => {}
		this.onServerRequest = () => ({})
		this.onExit = () => {}
		const pending = [...this.pending]
		this.pending.clear()
		for (const [, entry] of pending) {
			clearTimeout(entry.timer)
			entry.reject(new MspError('Muse Code connection closed', -32000))
		}
	}

	/** Remove the stdout/stderr listeners installed by `connect()`. */
	#releaseListeners() {
		if (this.onStdout !== undefined) {
			try {
				this.handle?.stdout?.off?.('data', this.onStdout)
			} catch {
				/* the stream is already gone */
			}
			this.onStdout = undefined
		}
		if (this.onStderr !== undefined) {
			try {
				this.handle?.stderr?.off?.('data', this.onStderr)
			} catch {
				/* the stream is already gone */
			}
			this.onStderr = undefined
		}
	}

	/** Close stdin and let the child drain, then terminate after the grace window. */
	async stop() {
		this.detach()
		try {
			this.handle?.stdin?.end?.()
		} catch {
			/* already closed */
		}
		try {
			await Promise.race([
				this.handle?.done,
				new Promise((resolve) => setTimeout(resolve, 1_500))
			])
		} catch {
			/* ignore */
		}
		try {
			this.handle?.terminate?.()
		} catch {
			/* already gone */
		}
	}

	/**
	 * Write one frame.
	 * @param {object} frame - JSON-RPC frame.
	 */
	#write(frame) {
		const stdin = this.handle?.stdin
		if (stdin === undefined || this.closed) return
		try {
			stdin.write(JSON.stringify(frame) + '\n')
		} catch (error) {
			this.logger?.warn?.('muse-code: write failed: ' + String(error?.message ?? error))
		}
	}

	/**
	 * Split the byte stream into lines and dispatch frames.
	 * @param {string} chunk - decoded stdout text.
	 */
	#ingest(chunk) {
		this.buffer += chunk
		let index
		while ((index = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, index).replace(/\r$/, '')
			this.buffer = this.buffer.slice(index + 1)
			if (line.length > MAX_LINE) {
				// A complete, newline-terminated frame that is still oversized is as
				// dangerous as an unterminated one: refuse to parse it at all.
				this.logger?.warn?.('muse-code: dropping oversized wire line (' + String(line.length) + ' bytes)')
				continue
			}
			if (line.trim() === '') continue
			let frame
			try {
				frame = JSON.parse(line)
			} catch {
				this.logger?.warn?.('muse-code: unparsable line ' + line.slice(0, 200))
				continue
			}
			this.#dispatch(frame)
		}
		if (this.buffer.length > MAX_LINE) {
			this.logger?.warn?.('muse-code: dropping oversized unterminated wire buffer (' + String(this.buffer.length) + ' bytes)')
			this.buffer = ''
		}
	}

	/**
	 * Route one decoded frame.
	 * @param {object} frame - JSON-RPC frame.
	 */
	#dispatch(frame) {
		if (frame.method !== undefined) {
			if (frame.id !== undefined) {
				let result
				try {
					result = this.onServerRequest(frame.method, frame.params ?? {})
				} catch (error) {
					this.respondError(frame.id, -32603, String(error?.message ?? error))
					return
				}
				this.respond(frame.id, result ?? {})
				return
			}
			try {
				this.onNotification(frame.method, frame.params ?? {})
			} catch (error) {
				this.logger?.warn?.('muse-code: notification handler failed: ' + String(error?.message ?? error))
			}
			return
		}
		const entry = this.pending.get(frame.id)
		if (entry === undefined) return
		this.pending.delete(frame.id)
		clearTimeout(entry.timer)
		if (frame.error !== undefined) {
			entry.reject(new MspError(String(frame.error.message ?? 'Muse Code request failed'), Number(frame.error.code), frame.error.data))
			return
		}
		entry.resolve(frame.result)
	}
}
