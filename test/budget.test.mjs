/**
 * Unit tests for the spend guard (`lib/budget.js`).
 *
 * Every test builds its own catalog + ledger inside a throw-away directory, so
 * nothing here touches the real `~/.dsh/muse-code-spend.json` or the real
 * `~/.local/share/muse/model-catalog`.
 *
 * The prices below are copied from the real catalog rows the Muse CLI ships
 * (`muse-spark-1.3-contributor` 0.10 / 0.20 / 0.002, `muse-spark-1.3`
 * 1.25 / 4.25 / 0.15, `muse-wonder-1.0` 4 / 20 / 0.2, limits 1007997 / 128000),
 * so the expected reserves match the numbers in the contract: $0.1264 for the
 * default model and $6.592 for the most expensive one.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
	DEFAULT_CAP_USD,
	SPEND_STATE_VERSION,
	SpendGuard,
	costFromCounters,
	formatUsd,
	loadModelCatalog,
	roundUsd,
	worstCaseCallUsd
} from '../lib/budget.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Context window every real catalog row declares. */
const CONTEXT_LIMIT = 1_007_997

/** Max output every real catalog row declares. */
const OUTPUT_LIMIT = 128_000

/** The six real catalog rows, trimmed to the fields the guard reads. */
const CATALOG_ROWS = [
	{
		model_id: 'muse-wonder-1.0',
		display_label: 'muse-wonder-1.0',
		is_default: false,
		context_limit: CONTEXT_LIMIT,
		output_limit: OUTPUT_LIMIT,
		background_agent_model: 'muse-spark-1.3',
		cost: { input: '4', output: '20', cached: '0.2', currency: 'USD' }
	},
	{
		model_id: 'muse-spark-1.3',
		display_label: 'muse-spark-1.3',
		is_default: false,
		context_limit: CONTEXT_LIMIT,
		output_limit: OUTPUT_LIMIT,
		background_agent_model: null,
		cost: { input: '1.25', output: '4.25', cached: '0.15', currency: 'USD' }
	},
	{
		model_id: 'muse-spark-1.3-contributor',
		display_label: 'muse-spark-1.3-contributor',
		is_default: true,
		context_limit: CONTEXT_LIMIT,
		output_limit: OUTPUT_LIMIT,
		background_agent_model: null,
		cost: { input: '0.10', output: '0.20', cached: '0.002', currency: 'USD' }
	},
	{
		model_id: 'muse-image-1.0',
		display_label: 'Muse Image',
		is_default: false,
		context_limit: null,
		output_limit: null,
		background_agent_model: null,
		cost: null
	},
	{
		model_id: 'muse-spark-1.2',
		display_label: 'muse-spark-1.2',
		is_default: false,
		context_limit: CONTEXT_LIMIT,
		output_limit: OUTPUT_LIMIT,
		background_agent_model: null,
		cost: { input: '1.25', output: '4.25', cached: '0.15', currency: 'USD' }
	},
	{
		model_id: 'muse-spark-1.2-contributor',
		display_label: 'muse-spark-1.2-contributor',
		is_default: false,
		context_limit: CONTEXT_LIMIT,
		output_limit: OUTPUT_LIMIT,
		background_agent_model: null,
		cost: { input: '0.10', output: '0.20', cached: '0.002', currency: 'USD' }
	}
]

/**
 * Create a directory for one fixture, preferring the platform temp dir and
 * falling back to the test directory when temp is not writable.
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
 * Build a throw-away catalog plus a factory for guards that share it.
 * @param {import('node:test').TestContext} t - test context, used for cleanup.
 * @returns {{root: string, catalogDir: string, guard: (name?: string, options?: object) => SpendGuard}} fixture.
 */
function fixture(t) {
	const root = makeRoot('muse-budget-')
	t.after(() => {
		try {
			rmSync(root, { recursive: true, force: true })
		} catch {
			/* a locked-down temp dir is not worth failing the test for */
		}
	})
	const catalogDir = join(root, 'catalog')
	mkdirSync(catalogDir, { recursive: true })
	writeFileSync(join(catalogDir, 'catalog.json'), JSON.stringify({
		schema_version: 2,
		provider_id: 'meta',
		profile_id: 'tbh',
		rows: CATALOG_ROWS
	}, null, 2), 'utf8')
	return {
		root,
		catalogDir,
		guard(name = 'spend', options = {}) {
			return new SpendGuard({ catalogDir, stateFile: join(root, name + '.json'), ...options })
		}
	}
}

/**
 * Assert two dollar amounts are equal within a tolerance.
 * @param {number} actual - observed value.
 * @param {number} expected - expected value.
 * @param {number} [tolerance] - absolute tolerance, default 1e-9.
 * @param {string} [message] - failure message.
 */
function near(actual, expected, tolerance = 1e-9, message) {
	assert.ok(Number.isFinite(actual), (message ?? '金额') + ' 不是有限数字：' + String(actual))
	assert.ok(Math.abs(actual - expected) <= tolerance, (message ?? '金额不符') + '：实际 ' + String(actual) + '，期望 ' + String(expected))
}

test('默认上限是 10 美元，构造后账本落盘', (t) => {
	const env = fixture(t)
	assert.equal(DEFAULT_CAP_USD, 10)
	assert.equal(SPEND_STATE_VERSION, 1)
	const guard = env.guard()
	assert.equal(guard.capUsd, 10)
	assert.equal(guard.snapshot().capUsd, 10)
	assert.equal(guard.locked, false)
	assert.equal(existsSync(join(env.root, 'spend.json')), true)
	const ledger = JSON.parse(readFileSync(join(env.root, 'spend.json'), 'utf8'))
	assert.equal(ledger.version, SPEND_STATE_VERSION)
	assert.equal(ledger.capUsd, 10)
	assert.equal(ledger.locked, false)
	assert.equal(guard.snapshot().lockedCode, null)
})

test('目录里的模型价格被正确读入，最坏单次成本按 context_limit/output_limit 计算', (t) => {
	const env = fixture(t)
	const catalog = loadModelCatalog({ catalogDir: env.catalogDir })
	assert.equal(catalog.models.size, 6)
	assert.equal(catalog.defaultModelId, 'muse-spark-1.3-contributor')
	assert.equal(catalog.catalogPath, join(env.catalogDir, 'catalog.json'))
	assert.deepEqual(catalog.maxPrices, { input: 4, output: 20, cached: 0.2 })
	near(catalog.maxWorstCaseUsd, 6.592, 1e-4, '目录最坏单次成本')

	const contributor = catalog.models.get('muse-spark-1.3-contributor')
	near(contributor.input, 0.1)
	near(contributor.output, 0.2)
	near(contributor.cached, 0.002)
	assert.equal(contributor.contextLimit, CONTEXT_LIMIT)
	assert.equal(contributor.outputLimit, OUTPUT_LIMIT)

	// 1007997 * 0.10 + 128000 * 0.20 = 126399.7 per million tokens -> $0.1263997；
	// reserveFor 会把它取整成契约里的 $0.1264。
	near(worstCaseCallUsd(contributor, { input: 0.1, output: 0.2 }), 0.1263997, 1e-9, 'contributor 未取整预留')
	// 1007997 * 4 + 128000 * 20 = 6591988 per million -> $6.591988
	near(worstCaseCallUsd(catalog.models.get('muse-wonder-1.0'), { input: 4, output: 20 }), 6.591988, 1e-9, 'wonder 未取整预留')
	// 缺省 limits 时按 1007997 / 128000 兜底，绝不按 0 预留
	near(worstCaseCallUsd({ contextLimit: null, outputLimit: null }, { input: 0.1, output: 0.2 }), 0.1263997, 1e-9)
	assert.ok(Number.isNaN(worstCaseCallUsd(contributor, { input: null, output: 0.2 })))
})

test('reserveFor：默认模型 $0.1264、最贵模型 $6.592、未知模型按目录最贵价格', (t) => {
	const env = fixture(t)
	const guard = env.guard()
	near(guard.reserveFor(undefined), 0.1264, 1e-9, '未指定模型时按默认模型')
	near(guard.reserveFor('muse-spark-1.3-contributor'), 0.1264, 1e-9)
	near(guard.reserveFor('muse-spark-1.3'), 1.804, 1e-4)
	near(guard.reserveFor('muse-wonder-1.0'), 6.592, 1e-4)
	near(guard.reserveFor('muse-image-1.0'), 6.592, 1e-4, '无价格的模型按目录最贵价格')
	const unknown = guard.reserveFor('muse-not-a-real-model')
	near(unknown, 6.592, 1e-4, '未知模型按目录最贵价格')
	assert.equal(unknown, guard.reserveFor('muse-wonder-1.0'))
	// 记住上一次报告里的模型，避免没有会话时退回到最便宜的默认模型
	guard.recordUsage({ sessionId: 'ses_m', cumulative: { cost: { usd: 0 } }, modelId: 'muse-wonder-1.0' })
	near(guard.reserveFor(undefined), 6.592, 1e-4, '未指定模型时沿用 lastModelId')
})

test('空目录：构造不抛，reserveFor 为 null，evaluate 返回 catalog-missing 且不锁定', (t) => {
	const env = fixture(t)
	const guard = new SpendGuard({ catalogDir: join(env.root, 'missing-catalog'), stateFile: join(env.root, 'spend.json') })
	assert.equal(guard.catalogOk, false)
	assert.equal(guard.reserveFor(undefined), null)
	assert.equal(guard.reserveFor('muse-spark-1.3-contributor'), null)
	const verdict = guard.evaluate(null)
	assert.equal(verdict.allowed, false)
	assert.equal(verdict.reasonCode, 'catalog-missing')
	assert.match(verdict.reasonMessage, /价格目录/)
	assert.equal(guard.locked, false, '目录缺失只暂停、不锁定')
	assert.equal(guard.snapshot().catalogOk, false)
})

test('costFromCounters：无缓存按全价、有缓存读按 cached 价、价格缺失返回 null', () => {
	const contributor = { input: 0.1, output: 0.2, cached: 0.002 }
	near(costFromCounters({ promptTokens: 1_000_000, outputTokens: 1_000_000 }, contributor), 0.3, 1e-9, '无缓存拆分')
	near(costFromCounters({ inputTokens: 1_000_000, outputTokens: 0 }, contributor), 0.1, 1e-9, 'inputTokens 别名')
	near(costFromCounters({
		promptTokens: 1_000_000,
		outputTokens: 0,
		cacheReadTokens: 1_000_000,
		cacheWriteTokens: 0
	}, contributor), 0.002, 1e-9, '缓存读按 cached 价')
	near(costFromCounters({
		promptTokens: 1_000_000,
		outputTokens: 0,
		cacheReadTokens: 800_000,
		cacheWriteTokens: 200_000
	}, contributor), (800_000 * 0.002 + 200_000 * 0.1) / 1_000_000, 1e-9, '缓存读 + 缓存写')
	assert.equal(costFromCounters({ promptTokens: 1 }, null), null)
	assert.equal(costFromCounters({ promptTokens: 1 }, { input: null, output: 0.2 }), null)
	assert.equal(costFromCounters({ outputTokens: 1 }, contributor), null, '没有输入计数无法计价')
	assert.equal(costFromCounters(null, contributor), null)
	// 只有 outputTokens 缺失时按 0 处理，不因缺字段放弃计价
	near(costFromCounters({ promptTokens: 0 }, contributor), 0)
})

test('recordUsage：服务端 cost 优先，本地估算更大时取本地，重复报告幂等', (t) => {
	const env = fixture(t)
	const server = env.guard('server')
	server.recordUsage({ sessionId: 'ses_s', cumulative: { cost: { usd: 1.5 } }, modelId: 'muse-spark-1.3-contributor' })
	assert.equal(server.spentUsd, 1.5)

	const local = env.guard('local')
	local.recordUsage({
		sessionId: 'ses_l',
		cumulative: {
			cost: { usd: 0.001 },
			promptTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0
		},
		modelId: 'muse-spark-1.3-contributor'
	})
	near(local.spentUsd, 0.3, 1e-9, '本地估算 0.3 大于服务端 0.001')

	const repeat = env.guard('repeat')
	const report = {
		sessionId: 'ses_r',
		cumulative: { cost: { usd: 2.25 }, promptTokens: 10, outputTokens: 10 },
		modelId: 'muse-spark-1.3-contributor'
	}
	const first = repeat.recordUsage(report)
	assert.equal(first.changed, true)
	const second = repeat.recordUsage({ ...report, cumulative: { ...report.cumulative, cost: { usd: 2.25 } } })
	assert.equal(second.changed, false, '同一份 cumulative 不应再记一次')
	assert.equal(repeat.spentUsd, 2.25)
	assert.equal(repeat.snapshot().calls, 1)
	assert.equal(repeat.snapshot().sessions, 1)
})

test('边界：9.8736 + 预留 0.1264 放行，9.9 + 预留 0.1264 拒绝，正好 10 为 cap-reached', (t) => {
	const env = fixture(t)
	const guard = env.guard('edge')
	guard.recordUsage({ sessionId: 'ses_e', cumulative: { cost: { usd: 9.8736 } } })
	const allowed = guard.evaluate(0.1264)
	assert.equal(allowed.allowed, true)
	assert.equal(allowed.reasonCode, null)
	assert.equal(allowed.reasonMessage, '')
	near(guard.snapshot().availableUsd, 0)

	guard.recordUsage({ sessionId: 'ses_e', cumulative: { cost: { usd: 9.9 } } })
	const refused = guard.evaluate(0.1264)
	assert.equal(refused.allowed, false)
	assert.equal(refused.reasonCode, 'safety-margin')
	assert.match(refused.reasonMessage, /预留 \$0\.1264/)
	assert.match(refused.reasonMessage, /超支/)
	assert.equal(refused.snapshot.locked, false, 'evaluate 只给结论，锁定由调用方执行')

	guard.recordUsage({ sessionId: 'ses_e', cumulative: { cost: { usd: 10 } } })
	const reached = guard.evaluate(0.1264)
	assert.equal(reached.allowed, false)
	assert.equal(reached.reasonCode, 'cap-reached')
	assert.match(reached.reasonMessage, /花费上限（\$10\.00）/)
})

test('锁定会落盘，新实例读同一账本仍然锁定', (t) => {
	const env = fixture(t)
	const first = env.guard('persist')
	first.recordUsage({ sessionId: 'ses_p', cumulative: { cost: { usd: 3.25 } } })
	const lockedSnapshot = first.lock('cap-reached')
	assert.equal(lockedSnapshot.locked, true)
	assert.equal(lockedSnapshot.lockedCode, 'cap-reached')
	assert.equal(lockedSnapshot.status, 'locked')

	const onDisk = JSON.parse(readFileSync(join(env.root, 'persist.json'), 'utf8'))
	assert.equal(onDisk.locked, true)
	assert.equal(onDisk.lockedCode, 'cap-reached')
	assert.equal(typeof onDisk.lockedAt, 'number')

	const second = env.guard('persist')
	assert.equal(second.locked, true)
	assert.equal(second.snapshot().lockedCode, 'cap-reached')
	assert.equal(second.snapshot().lockedReason, lockedSnapshot.lockedReason)
	assert.equal(second.spentUsd, 3.25, '锁定后花费记录仍在')
	const verdict = second.evaluate(0.1264)
	assert.equal(verdict.allowed, false)
	assert.equal(verdict.reasonCode, 'cap-reached')
})

test('账本损坏：改名保留 .corrupt-*，按 ledger-corrupt 锁定而不是清零', (t) => {
	const env = fixture(t)
	const broken = join(env.root, 'broken.json')
	writeFileSync(broken, '{ "version": 1, "sessions": ', 'utf8')
	const guard = new SpendGuard({ catalogDir: env.catalogDir, stateFile: broken })
	assert.equal(guard.locked, true)
	assert.equal(guard.snapshot().lockedCode, 'ledger-corrupt')
	assert.match(guard.snapshot().lockedReason, /账本损坏/)
	const kept = readdirSync(env.root).filter((name) => name.startsWith('broken.json.corrupt-'))
	assert.equal(kept.length, 1, '损坏的账本必须改名保留')
	assert.ok(statSync(join(env.root, kept[0])).size > 0)
	// 锁定优先于 setCap：只有 reset() 能清掉这份不可信的花费记录
	guard.setCap(100)
	assert.equal(guard.locked, true)
	assert.equal(guard.snapshot().lockedCode, 'ledger-corrupt')
	guard.reset()
	assert.equal(guard.locked, false)

	const wrongVersion = join(env.root, 'wrong-version.json')
	writeFileSync(wrongVersion, JSON.stringify({ version: 99, sessions: {} }), 'utf8')
	const mismatched = new SpendGuard({ catalogDir: env.catalogDir, stateFile: wrongVersion })
	assert.equal(mismatched.locked, true)
	assert.equal(mismatched.snapshot().lockedCode, 'ledger-corrupt')
	assert.equal(readdirSync(env.root).filter((name) => name.startsWith('wrong-version.json.corrupt-')).length, 1)
})

test('setCap：非法值抛错，提高上限后解锁，reset 清零但保留上限', (t) => {
	const env = fixture(t)
	const guard = env.guard('cap')
	assert.throws(() => guard.setCap(0), /花费上限/)
	assert.throws(() => guard.setCap(-1), /花费上限/)
	assert.throws(() => guard.setCap(Number.NaN), /花费上限/)
	assert.throws(() => guard.setCap(Number.POSITIVE_INFINITY), /花费上限/)
	assert.throws(() => guard.setCap('10'), /花费上限/)
	assert.throws(() => guard.setCap(100_001), /花费上限/)
	assert.equal(guard.capUsd, 10, '非法调用不得改动上限')

	guard.recordUsage({ sessionId: 'ses_c', cumulative: { cost: { usd: 9.9 } } })
	const verdict = guard.evaluate(0.1264)
	assert.equal(verdict.reasonCode, 'safety-margin')
	guard.lock(verdict.reasonCode)
	assert.equal(guard.locked, true)
	assert.equal(guard.setCap(20).locked, false, '提高上限后 spent + reserved <= cap 应解锁')
	assert.equal(guard.capUsd, 20)
	assert.equal(guard.locked, false)

	const cleared = guard.reset()
	assert.equal(cleared.spentUsd, 0)
	assert.equal(cleared.sessions, 0)
	assert.equal(cleared.locked, false)
	assert.equal(cleared.capUsd, 20, 'reset 保留用户设置的上限')
	assert.equal(JSON.parse(readFileSync(join(env.root, 'cap.json'), 'utf8')).capUsd, 20)
})

test('recordTurnUsage：同一 turnId 只计一次，不同 turnId 累加', (t) => {
	const env = fixture(t)
	const guard = env.guard('turn')
	const usage = { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0 }
	const first = guard.recordTurnUsage({ sessionId: 'ses_t', usage, modelId: 'muse-wonder-1.0', turnId: 'turn_1' })
	assert.equal(first.changed, true)
	near(guard.spentUsd, 4, 1e-9)
	const replay = guard.recordTurnUsage({ sessionId: 'ses_t', usage, modelId: 'muse-wonder-1.0', turnId: 'turn_1' })
	assert.equal(replay.changed, false, '重复的 turn 事件不得重复计费')
	near(guard.spentUsd, 4, 1e-9)
	const next = guard.recordTurnUsage({ sessionId: 'ses_t', usage, modelId: 'muse-wonder-1.0', turnId: 'turn_2' })
	assert.equal(next.changed, true)
	near(guard.spentUsd, 8, 1e-9)
	assert.equal(guard.snapshot().sessions, 1)
	assert.equal(guard.snapshot().lastModelId, 'muse-wonder-1.0')
})

test('目录不可用或目录内没有可解析文件时都返回空目录，不抛异常', (t) => {
	const env = fixture(t)
	const garbageDir = join(env.root, 'garbage')
	mkdirSync(garbageDir, { recursive: true })
	writeFileSync(join(garbageDir, 'broken.json'), 'not json at all', 'utf8')
	writeFileSync(join(garbageDir, 'notes.txt'), 'ignored', 'utf8')
	const empty = loadModelCatalog({ catalogDir: garbageDir })
	assert.equal(empty.models.size, 0)
	assert.equal(empty.maxPrices, null)
	assert.equal(empty.maxWorstCaseUsd, null)
	assert.equal(empty.catalogPath, null)

	const missing = loadModelCatalog({ catalogDir: join(env.root, 'nope') })
	assert.equal(missing.models.size, 0)

	const guard = new SpendGuard({ catalogDir: garbageDir, stateFile: join(env.root, 'garbage.json') })
	assert.equal(guard.catalogOk, false)
	assert.equal(guard.locked, false)
	assert.equal(guard.evaluate(null).reasonCode, 'catalog-missing')
})

test('roundUsd / formatUsd 的输出符合面板文案约定', () => {
	assert.equal(roundUsd(0.1 + 0.2), 0.3)
	assert.equal(roundUsd(0.1263997), 0.1264)
	assert.equal(roundUsd(6.5919883), 6.591988)
	assert.equal(formatUsd(10), '$10.00')
	assert.equal(formatUsd(0), '$0.00')
	assert.equal(formatUsd(-1.5), '$-1.50')
	assert.equal(formatUsd(0.1264), '$0.13')
	assert.equal(formatUsd(0.002), '$0.0020')
	assert.equal(formatUsd(Number.NaN), '$?')
	assert.equal(formatUsd(undefined), '$?')
})

test('snapshot 全是可 JSON 序列化的普通值', (t) => {
	const env = fixture(t)
	const guard = env.guard()
	guard.setReserve(0.1264)
	const snapshot = guard.evaluate(0.1264).snapshot
	const round = JSON.parse(JSON.stringify(snapshot))
	assert.deepEqual(round, snapshot)
	assert.equal(snapshot.capUsd, 10)
	assert.equal(snapshot.reservedUsd, 0.1264)
	assert.equal(snapshot.availableUsd, 9.8736)
	assert.equal(snapshot.status, 'ok')
	assert.equal(snapshot.catalogOk, true)
	assert.equal(typeof snapshot.updatedAt, 'number')
})
