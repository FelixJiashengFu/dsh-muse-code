/**
 * A fake `muse serve` for the spend-cap tests: NDJSON JSON-RPC 2.0 over stdio,
 * exactly the framing `lib/msp.js` expects.
 *
 * It answers the five methods the controller calls and, right after the
 * `turn/start` ack, reports a session-cumulative cost. That is what lets the
 * enforcement test drive the guard over (or under) its cap without ever
 * contacting the real CLI — no account, no network, no money.
 *
 * Environment knobs:
 *  - `MUSE_FAKE_COST_USD`  cumulative `cost.usd` reported for the turn (default `9.99`;
 *    `0.01` is the "still allowed" case).
 *  - `MUSE_FAKE_SESSION_ID` session id (default `ses_fake`).
 *  - `MUSE_FAKE_TURN_ID`    turn id (default `turn_1`).
 *  - `MUSE_FAKE_MODEL_ID`   model id (default `muse-spark-1.3-contributor`).
 *
 * It only starts serving when `MUSE_FAKE_SERVE=1`: `node --test` treats every
 * file below a `test/` directory as a test file, and a fixture that blocks on
 * stdin would hang that run. Without the flag it exits immediately, which the
 * runner records as an empty (passing) test file.
 */

if (process.env.MUSE_FAKE_SERVE !== '1') {
	// Under the test runner the hint would only be noise; a human running the
	// fixture by hand gets told why it did nothing.
	if (process.env.NODE_TEST_CONTEXT === undefined) {
		process.stderr.write('fake muse serve: 这是测试夹具，需设置 MUSE_FAKE_SERVE=1 才会应答。\n')
	}
	process.exit(0)
}

const COST_USD = Number(process.env.MUSE_FAKE_COST_USD ?? '9.99')
const SESSION_ID = process.env.MUSE_FAKE_SESSION_ID ?? 'ses_fake'
const TURN_ID = process.env.MUSE_FAKE_TURN_ID ?? 'turn_1'
const MODEL_ID = process.env.MUSE_FAKE_MODEL_ID ?? 'muse-spark-1.3-contributor'

/** The workspace the parent asked for; echoed back inside the session. */
let workspaceRoot = process.cwd()

/**
 * Write one JSON text frame to stdout.
 * @param {object} frame - JSON-RPC frame.
 */
function send(frame) {
	process.stdout.write(JSON.stringify(frame) + '\n')
}

/**
 * Answer one client request.
 * @param {number | string | undefined} id - request id.
 * @param {object} result - result payload.
 */
function reply(id, result) {
	if (id === undefined) return
	send({ jsonrpc: '2.0', id, result })
}

/**
 * Emit one server notification.
 * @param {string} method - notification method.
 * @param {object} params - notification params.
 */
function notify(method, params) {
	send({ jsonrpc: '2.0', method, params })
}

/**
 * Report the turn and then let the process die: the guard is expected to stop
 * the child, and an honest fake must not outlive its stdin.
 */
function leave() {
	process.exitCode = 0
	// Dropping the reader on the next tick lets the leave ack flush first.
	setImmediate(() => {
		process.stdin.destroy()
	})
}

/**
 * Drive one fake turn: ack, then the lifecycle notifications a real host sends.
 * @param {object} frame - the `turn/start` request.
 */
function runTurn(frame) {
	reply(frame.id, {
		commandId: frame.params?.commandId,
		turnId: TURN_ID,
		disposition: 'newTurn'
	})
	// Notifications follow the ack, like a real host.
	setImmediate(() => {
		notify('turn/started', { sessionId: SESSION_ID, turnId: TURN_ID })
		notify('session/tokenUsage', {
			sessionId: SESSION_ID,
			modelId: MODEL_ID,
			cumulative: {
				promptTokens: 1_000,
				outputTokens: 100,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				cost: { usd: COST_USD, partial: false }
			}
		})
		notify('turn/completed', {
			sessionId: SESSION_ID,
			turnId: TURN_ID,
			terminal: { status: 'completed' },
			durationMs: 12,
			usage: {
				inputTokens: 1_000,
				outputTokens: 100,
				cachedTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0
			}
		})
	})
}

/**
 * Handle one decoded frame.
 * @param {object} frame - JSON-RPC frame.
 */
function handle(frame) {
	switch (frame.method) {
		case 'initialize':
			reply(frame.id, {
				serverInfo: { name: 'fake-muse', version: '0.0.0-fake' },
				sandboxAvailability: 'available',
				schema: { version: 1, fingerprint: 'fake-schema' }
			})
			return
		case 'initialized':
			return
		case 'session/start':
			workspaceRoot = frame.params?.workspaceRoot ?? workspaceRoot
			reply(frame.id, {
				session: {
					sessionId: SESSION_ID,
					modelId: MODEL_ID,
					providerId: 'meta',
					status: 'idle',
					workspaceRoot,
					approvalMode: { mode: frame.params?.approvalMode ?? 'onRequest' },
					turnCount: 0
				},
				viewCursor: 'c1'
			})
			return
		case 'turn/start':
			runTurn(frame)
			return
		case 'turn/interrupt':
			reply(frame.id, {
				commandId: frame.params?.commandId,
				turnId: frame.params?.turnId ?? TURN_ID,
				interrupted: true
			})
			return
		case 'session/leave':
			reply(frame.id, {})
			leave()
			return
		default:
			// Unknown methods are acknowledged instead of ignored so a hung test
			// points at the controller, not at this fake.
			reply(frame.id, { ok: true })
			return
	}
}

/** @type {string} unterminated tail of the input stream. */
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('error', () => {
	/* the parent may close the pipe first */
})
process.stdin.on('data', (chunk) => {
	buffer += chunk
	let index
	while ((index = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, index).replace(/\r$/, '')
		buffer = buffer.slice(index + 1)
		if (line.trim() === '') continue
		let frame
		try {
			frame = JSON.parse(line)
		} catch {
			continue
		}
		if (frame === null || typeof frame !== 'object' || frame.method === undefined) continue
		handle(frame)
	}
})
process.stdin.on('end', () => {
	process.exitCode = 0
})
process.stdin.on('close', () => {
	process.exitCode = 0
})
process.stdout.on('error', () => {
	process.exit(0)
})
