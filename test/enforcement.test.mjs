/**
 * Enforcement tests: the spend cap must actually stop Muse Code.
 *
 * Two transports are used, both speaking the real MSP wire through the real
 * `MspConnection` and the real `MuseController`:
 *
 *  - `InProcessMuseHost` — a `muse serve` stand-in that implements the child
 *    contract (`stdout`/`stderr`/`stdin` streams, `done`, `terminate()`) without
 *    an OS process. This is the always-on path: a sandboxed test runner may
 *    forbid spawning children with piped stdio (EPERM), and the behaviour under
 *    test lives in the controller, not in `child_process`.
 *  - `fake-muse-serve.mjs` — the same fake as a real child process, used by the
 *    third test whenever this machine allows piped children.
 *
 * The scenario in both cases: `session/tokenUsage` reports a cumulative
 * `cost.usd` of 9.99, which plus the $0.1264 worst-case reserve crosses the
 * $10 cap. The guard must lock, publish the reason, interrupt the turn, leave
 * the session, kill the child and refuse every later prompt.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { SpendGuard } from '../lib/budget.js'
import { MuseController } from '../lib/controller.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The real `muse serve` replacement used by the subprocess test. */
const FAKE_SCRIPT = join(HERE, 'fake-muse-serve.mjs')

/** Prices copied from the real catalog rows the two models use. */
const CATALOG_ROWS = [
	{
		model_id: 'muse-wonder-1.0',
		display_label: 'muse-wonder-1.0',
		is_default: false,
		context_limit: 1_007_997,
		output_limit: 128_000,
		background_agent_model: 'muse-spark-1.3',
		cost: { input: '4', output: '20', cached: '0.2', currency: 'USD' }
	},
	{
		model_id: 'muse-spark-1.3-contributor',
		display_label: 'muse-spark-1.3-contributor',
		is_default: true,
		context_limit: 1_007_997,
		output_limit: 128_000,
		background_agent_model: null,
		cost: { input: '0.10', output: '0.20', cached: '0.002', currency: 'USD' }
	}
]

/** Silent logger; set `MUSE_TEST_DEBUG=1` to see the controller's warnings. */
const logger = {
	info() {},
	debug() {},
	warn(...args) {
		if (process.env.MUSE_TEST_DEBUG === '1') console.error('[muse-test]', ...args)
	}
}

/**
 * Create a directory for one fixture, preferring the platform temp dir.
 * @param {string} tag - directory name prefix.
 * @returns {string} the created directory.
 */
function makeRoot(tag) {
	for (const base of [tmpdir(), HERE]) {
		try {
			return mkdtempSync(join(base, tag))
		} catch {
			continue
		}
	}
	throw new Error('无法创建临时目录')
}

/**
 * One test's model catalog, ledger, and captured panel events.
 * @param {import('node:test').TestContext} t - test context, used for cleanup.
 * @param {object} [options] - fixture knobs.
 * @param {object[]} [options.catalogRows] - rows to write; an empty list leaves
 *   the catalog directory empty, which is the "catalog unavailable" case.
 * @returns {object} fixture.
 */
function fixture(t, { catalogRows = CATALOG_ROWS } = {}) {
	const root = makeRoot('muse-enforce-')
	const catalogDir = join(root, 'catalog')
	if (catalogRows.length > 0) {
		mkdirSync(catalogDir, { recursive: true })
		writeFileSync(join(catalogDir, 'catalog.json'), JSON.stringify({
			schema_version: 2,
			provider_id: 'meta',
			profile_id: 'tbh',
			rows: catalogRows
		}, null, 2), 'utf8')
	}
	const events = []
	t.after(() => {
		try {
			rmSync(root, { recursive: true, force: true })
		} catch {
			/* keep the test result; a leftover temp dir is harmless */
		}
	})
	return {
		root,
		catalogDir,
		stateFile: join(root, 'spend.json'),
		budget: new SpendGuard({ catalogDir, stateFile: join(root, 'spend.json'), logger }),
		events,
		emit(event) {
			events.push(event)
		}
	}
}

/**
 * Poll until `predicate` holds or the deadline passes.
 * @param {() => boolean} predicate - condition to wait for.
 * @param {number} timeoutMs - how long to wait.
 * @param {string} label - failure text.
 * @returns {Promise<void>} resolves when the condition holds.
 */
async function waitFor(predicate, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) return
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	assert.fail('超时 ' + String(timeoutMs) + 'ms：' + label)
}

/**
 * Whether this machine lets us spawn a child with piped stdio. Sandboxed
 * runners answer no with EPERM; the subprocess test then skips instead of
 * failing for an environment reason.
 * @returns {boolean} true when `spawn(..., {stdio: 'pipe'})` is allowed.
 */
function canSpawnChildren() {
	try {
		const probe = spawn(process.execPath, ['-e', 'process.exit(0)'], {
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true
		})
		probe.on('error', () => {})
		probe.stdout?.on('data', () => {})
		probe.stderr?.on('data', () => {})
		probe.stdin?.on('error', () => {})
		return true
	} catch {
		return false
	}
}

/**
 * A `muse serve` stand-in that keeps the child contract without an OS process.
 *
 * It answers the same methods and sends the same notifications as
 * `fake-muse-serve.mjs`, so the controller's wire path is exercised for real.
 */
class InProcessMuseHost {
	/**
	 * @param {object} [options] - scenario knobs.
	 * @param {number} [options.costUsd] - cumulative `cost.usd` reported per turn.
	 * @param {string} [options.sessionId] - session id.
	 * @param {string} [options.turnId] - turn id.
	 * @param {string} [options.modelId] - model id reported by the session.
	 */
	constructor({ costUsd = 9.99, sessionId = 'ses_fake', turnId = 'turn_1', modelId = 'muse-spark-1.3-contributor' } = {}) {
		this.costUsd = costUsd
		this.sessionId = sessionId
		this.turnId = turnId
		this.modelId = modelId
		this.stdout = new PassThrough()
		this.stderr = new PassThrough()
		this.stdin = new PassThrough()
		/** @type {string[]} request methods received, in order. */
		this.methods = []
		/** @type {object[]} every decoded frame received, in order. */
		this.frames = []
		this.terminated = false
		this.exitCode = null
		this.buffer = ''
		this.resolveDone = undefined
		this.done = new Promise((resolve) => {
			this.resolveDone = resolve
		})
		this.stdin.on('data', (chunk) => this.ingest(String(chunk)))
		this.stdin.on('finish', () => this.exit(0))
		this.stdin.on('error', () => {})
		this.stdout.on('error', () => {})
		this.stderr.on('error', () => {})
	}

	/**
	 * Mark the child as gone; idempotent so `stop()` can terminate after exit.
	 * @param {number} code - exit code.
	 */
	exit(code) {
		if (this.exitCode !== null) return
		this.exitCode = code
		this.resolveDone({ exitCode: code })
	}

	/** The kill switch `MspConnection.stop()` calls. */
	terminate() {
		this.terminated = true
		this.exit(1)
	}

	/**
	 * Write one frame unless the child is already gone.
	 * @param {object} frame - JSON-RPC frame.
	 */
	send(frame) {
		if (this.exitCode !== null) return
		this.stdout.write(JSON.stringify(frame) + '\n')
	}

	/**
	 * Answer one request.
	 * @param {object} frame - request frame.
	 * @param {object} result - result payload.
	 */
	reply(frame, result) {
		if (frame.id === undefined) return
		this.send({ jsonrpc: '2.0', id: frame.id, result })
	}

	/**
	 * Emit one notification.
	 * @param {string} method - notification method.
	 * @param {object} params - notification params.
	 */
	notify(method, params) {
		this.send({ jsonrpc: '2.0', method, params })
	}

	/**
	 * Split the controller's writes into frames.
	 * @param {string} chunk - stdin text.
	 */
	ingest(chunk) {
		this.buffer += chunk
		let index
		while ((index = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, index).replace(/\r$/, '')
			this.buffer = this.buffer.slice(index + 1)
			if (line.trim() === '') continue
			let frame
			try {
				frame = JSON.parse(line)
			} catch {
				continue
			}
			if (frame === null || typeof frame !== 'object' || frame.method === undefined) continue
			this.frames.push(frame)
			// Only requests are recorded here; notifications (`initialized`) stay in
			// `frames` so a test can see them without polluting the request order.
			if (frame.id !== undefined) this.methods.push(frame.method)
			this.handle(frame)
		}
	}

	/**
	 * Answer one frame the way the real host does.
	 * @param {object} frame - JSON-RPC frame.
	 */
	handle(frame) {
		switch (frame.method) {
			case 'initialize':
				this.reply(frame, {
					serverInfo: { name: 'fake-muse', version: '0.0.0-inproc' },
					sandboxAvailability: 'available',
					schema: { version: 1, fingerprint: 'fake-schema' }
				})
				return
			case 'initialized':
				return
			case 'session/start':
				this.reply(frame, {
					session: {
						sessionId: this.sessionId,
						modelId: this.modelId,
						providerId: 'meta',
						status: 'idle',
						workspaceRoot: frame.params?.workspaceRoot ?? process.cwd(),
						approvalMode: { mode: frame.params?.approvalMode ?? 'onRequest' },
						turnCount: 0
					},
					viewCursor: 'c1'
				})
				return
			case 'turn/start': {
				this.reply(frame, {
					commandId: frame.params?.commandId,
					turnId: this.turnId,
					disposition: 'newTurn'
				})
				// The lifecycle notifications follow the ack, like a real host.
				setImmediate(() => {
					this.notify('turn/started', { sessionId: this.sessionId, turnId: this.turnId })
					this.notify('session/tokenUsage', {
						sessionId: this.sessionId,
						modelId: this.modelId,
						cumulative: {
							promptTokens: 1_000,
							outputTokens: 100,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							cost: { usd: this.costUsd, partial: false }
						}
					})
					this.notify('turn/completed', {
						sessionId: this.sessionId,
						turnId: this.turnId,
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
				return
			}
			case 'turn/interrupt':
				this.reply(frame, {
					commandId: frame.params?.commandId,
					turnId: frame.params?.turnId ?? this.turnId,
					interrupted: true
				})
				return
			case 'session/leave':
				this.reply(frame, {})
				this.exit(0)
				return
			default:
				this.reply(frame, { ok: true })
				return
		}
	}
}

/**
 * Wire a controller to the in-process host.
 * @param {object} env - fixture.
 * @param {InProcessMuseHost} host - the fake child.
 * @returns {{controller: MuseController, specs: object[]}} the wiring.
 */
function wireInProcess(env, host) {
	const specs = []
	const controller = new MuseController({
		spawn: (spec) => {
			specs.push(spec)
			return host
		},
		logger,
		resolveWorkspace: () => env.root,
		emit: env.emit,
		budget: env.budget,
		launch: { argv: [process.execPath, FAKE_SCRIPT] }
	})
	return { controller, specs }
}

test('花费上限：cost.usd=9.99 在 5 秒内锁定并强制停止，后续 prompt 一律拒绝', { timeout: 30_000 }, async (t) => {
	const env = fixture(t)
	const host = new InProcessMuseHost({ costUsd: 9.99 })
	const { controller, specs } = wireInProcess(env, host)
	t.after(async () => {
		try {
			await controller.stop()
		} catch {
			/* already stopped by the cap */
		}
	})

	await controller.start()
	assert.equal(controller.status, 'idle')
	assert.deepEqual(host.methods.slice(0, 2), ['initialize', 'session/start'], '先握手再开会话')
	assert.ok(host.frames.some((frame) => frame.method === 'initialized'), '应发出 initialized 通知')
	assert.equal(specs.length, 1)
	assert.deepEqual(specs[0].stdio, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
	assert.equal(specs[0].cwd, env.root)
	assert.deepEqual(specs[0].argv.slice(-3), ['--provider', 'meta', '--trust-workspace'])
	assert.equal(controller.snapshot().budget.capUsd, 10)
	assert.equal(controller.snapshot().budget.reservedUsd, 0.1264, '会话建立后按当前模型的预留做预检')
	assert.equal(env.budget.locked, false)

	await controller.prompt('hi')
	await waitFor(() => env.events.some((event) => event.type === 'status' && event.status === 'off' && typeof event.error === 'string' && event.error.includes('花费上限')), 5_000, '5 秒内锁定并强制停止')

	// 账本与快照
	assert.equal(env.budget.locked, true)
	assert.equal(env.budget.snapshot().lockedCode, 'safety-margin')
	assert.match(env.budget.snapshot().lockedReason, /预留 \$0\.1264/)
	assert.ok(env.budget.spentUsd >= 9.99, '已花费应包含 9.99 的服务端累计')
	assert.equal(controller.status, 'off')
	assert.equal(controller.snapshot().status, 'off')
	assert.equal(controller.snapshot().budget.locked, true)
	assert.match(String(controller.snapshot().lastError), /花费上限已触发/)
	assert.match(String(controller.snapshot().lastError), /不会再发起任何模型调用/)

	// 面板事件：budget 快照 + 带原因的 off 状态
	const budgetEvents = env.events.filter((event) => event.type === 'budget')
	assert.ok(budgetEvents.length >= 1, '应发出 budget 事件')
	assert.ok(budgetEvents.some((event) => event.budget?.locked === true))
	assert.ok(env.events.some((event) => event.type === 'turn'), '已完成的一轮仍应上报 turn 事件')

	// 关停动作：interrupt 尽力、leave、杀子进程
	assert.ok(host.methods.includes('turn/interrupt'), '应先尝试打断当前轮次')
	assert.ok(host.methods.includes('session/leave'), '应让会话优雅退出')
	assert.equal(host.terminated, true, '子进程必须被终止')
	assert.notEqual(host.exitCode, null)

	// 锁定持久化到账本
	const ledger = JSON.parse(readFileSync(env.stateFile, 'utf8'))
	assert.equal(ledger.locked, true)
	assert.equal(ledger.lockedCode, 'safety-margin')
	assert.ok(ledger.spentUsdAtLock >= 9.99)

	// 锁定之后：拒绝 prompt，且不再启动子进程 / 不再发起模型调用
	assert.equal(host.methods.filter((method) => method === 'turn/start').length, 1)
	await assert.rejects(
		() => controller.prompt('again'),
		(error) => String(error?.message ?? '').includes('花费上限'),
		'锁定后 prompt 必须被拒绝'
	)
	assert.equal(specs.length, 1, '锁定后不得再 spawn')
	assert.equal(host.methods.filter((method) => method === 'turn/start').length, 1, '锁定后不得再发起 turn')
	await assert.rejects(() => controller.start(), (error) => String(error?.message ?? '').includes('花费上限'))
	assert.equal(specs.length, 1)
})

test('未到上限：cost.usd=0.01 不锁定，会话回到 idle 且还能继续', { timeout: 30_000 }, async (t) => {
	const env = fixture(t)
	const host = new InProcessMuseHost({ costUsd: 0.01 })
	const { controller, specs } = wireInProcess(env, host)
	t.after(async () => {
		try {
			await controller.stop()
		} catch {
			/* ignore */
		}
	})

	await controller.start()
	await controller.prompt('hi')
	await waitFor(() => env.budget.snapshot().calls >= 2 && controller.status === 'idle', 5_000, '两次用量报告都折入了账本')

	assert.equal(env.budget.locked, false)
	assert.ok(Math.abs(env.budget.spentUsd - 0.01) < 1e-9, '花费应为 0.01，实际 ' + String(env.budget.spentUsd))
	assert.equal(controller.snapshot().lastTurn?.turnId, 'turn_1')
	assert.equal(
		env.events.some((event) => event.type === 'status' && event.status === 'off' && event.error !== undefined),
		false,
		'不应发出带错误的 off 状态'
	)

	// 还能继续：第二轮正常发出
	await controller.prompt('again')
	await waitFor(() => host.methods.filter((method) => method === 'turn/start').length === 2, 5_000, '第二轮 turn/start')
	assert.equal(env.budget.locked, false)
	assert.equal(JSON.parse(readFileSync(env.stateFile, 'utf8')).locked, false)

	await controller.stop()
	assert.equal(controller.status, 'off')
	assert.equal(specs.length, 1, 'stop 不重启子进程')
	assert.equal(host.terminated, true)
})

test('价格目录不可用：拒绝调用但不锁定，也不杀会话（fail-closed 只暂停）', { timeout: 30_000 }, async (t) => {
	const env = fixture(t, { catalogRows: [] })
	assert.equal(env.budget.catalogOk, false)
	const host = new InProcessMuseHost({ costUsd: 0.01 })
	const { controller } = wireInProcess(env, host)
	t.after(async () => {
		try {
			await controller.stop()
		} catch {
			/* nothing to stop */
		}
	})

	// 会话照常建立：目录缺失不是启动错误，只是不允许再花钱。
	await controller.start()
	assert.equal(controller.status, 'idle')
	assert.equal(env.budget.locked, false, '目录缺失不锁定')
	assert.equal(controller.snapshot().budget.catalogOk, false)
	assert.equal(controller.snapshot().budget.reservedUsd, 0)
	assert.ok(env.events.some((event) => event.type === 'budget' && event.budget.catalogOk === false), '预检应把目录状态推给面板')

	await assert.rejects(() => controller.prompt('hi'), /无法读取 Muse 模型价格目录/)
	assert.equal(env.budget.locked, false, '拒绝不等于锁定')
	assert.equal(controller.status, 'idle', '只暂停，不杀会话')
	assert.equal(host.terminated, false)
	assert.equal(host.methods.filter((method) => method === 'turn/start').length, 0, '没有发出 turn/start')
})

test('真实子进程：fake muse serve 全程走 stdio 也能正常启动与关停', { timeout: 30_000 }, async (t) => {
	if (!canSpawnChildren()) {
		t.skip('当前沙箱禁止带管道的子进程（spawn EPERM），已由上面的进程内传输覆盖同一路径')
		return
	}
	const env = fixture(t)
	const children = []
	const controller = new MuseController({
		spawn: (spec) => {
			const [command, ...args] = spec.argv
			const child = spawn(command, args, {
				cwd: spec.cwd,
				stdio: ['pipe', 'pipe', 'pipe'],
				env: { ...process.env, MUSE_FAKE_COST_USD: '0.01', MUSE_FAKE_SERVE: '1' },
				windowsHide: true
			})
			children.push(child)
			const done = new Promise((resolve) => {
				child.on('error', () => resolve({ exitCode: 1 }))
				child.on('exit', (code) => resolve({ exitCode: typeof code === 'number' ? code : 1 }))
			})
			return {
				stdout: child.stdout,
				stderr: child.stderr,
				stdin: child.stdin,
				done,
				terminate: () => {
					try {
						child.kill()
					} catch {
						/* already gone */
					}
				}
			}
		},
		logger,
		resolveWorkspace: () => env.root,
		emit: env.emit,
		budget: env.budget,
		launch: { argv: [process.execPath, FAKE_SCRIPT] }
	})
	t.after(async () => {
		try {
			await controller.stop()
		} catch {
			/* ignore */
		}
	})

	await controller.start()
	assert.equal(controller.status, 'idle')
	assert.equal(children.length, 1)
	assert.equal(children[0].exitCode, null, '子进程应在运行')
	await controller.prompt('hi')
	await waitFor(() => env.budget.snapshot().calls >= 2 && controller.status === 'idle', 5_000, '子进程回报用量')
	assert.equal(env.budget.locked, false)
	assert.ok(Math.abs(env.budget.spentUsd - 0.01) < 1e-9)
	await controller.stop()
	await waitFor(() => children[0].exitCode !== null, 5_000, '子进程应退出')
	assert.equal(controller.status, 'off')
})
