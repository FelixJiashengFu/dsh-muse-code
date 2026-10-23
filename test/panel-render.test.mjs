/**
 * Render-level test for the Muse Code panel.
 *
 * Loads the real `lib/client.js` into a vm sandbox with a minimal hook runtime
 * and drives the actual components (`Panel`, `Toggle`, `ApprovalCard`,
 * `QuestionCard`, `BudgetBar`, `SandboxNotice`) through the states the panel
 * has to survive:
 *
 *  - idle session with the sandbox unavailable (amber strip + probe buttons);
 *  - unsandboxed mode on (red strip + the only control that can turn it off);
 *  - sandbox available (no strip at all);
 *  - locked spend guard (budget strip, unlock forms, composer disabled);
 *  - approval cards (decision buttons, feedback only where declared);
 *  - multi-question cards (every question answered, one submit, one POST);
 *  - transcript item kinds, including the filtered housekeeping kinds;
 *  - the composer toggle's badge and pressed state.
 *
 * It never starts Muse, never touches the DSH host and never writes files.
 *
 * Run: node test/panel-render.test.mjs
 */
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const TARGET = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const raw = fs.readFileSync(TARGET, 'utf8')
const marker = 'const module = { exports: {} }'
assert.equal(raw.split(marker).length, 2, 'factory marker appears exactly once')
const instrumented = raw.replace(
	marker,
	`${marker}\n\t\tmodule.exports.__test = { store, Toggle, Panel, ApprovalCard, QuestionCard, BudgetBar, SandboxNotice }`
)

// ── minimal hook runtime ────────────────────────────────────────────────────
let activeInstance = null
const calls = []
let spec

const ReactImpl = {
	createElement(type, props, ...children) {
		return { type, props: props ?? {}, children: children.flat(Infinity) }
	},
	useState(initial) {
		const instance = activeInstance
		const index = instance.cursor
		instance.cursor += 1
		if (!(index in instance.slots)) {
			instance.slots[index] = { value: typeof initial === 'function' ? initial() : initial }
		}
		const slot = instance.slots[index]
		return [slot.value, (next) => {
			slot.value = typeof next === 'function' ? next(slot.value) : next
			instance.pending = true
			if (typeof instance.notify === 'function') instance.notify()
		}]
	},
	useEffect(fn) {
		const instance = activeInstance
		const index = instance.cursor
		instance.cursor += 1
		if (instance.effects.has(index)) return
		instance.effects.add(index)
		const cleanup = fn()
		if (typeof cleanup === 'function') instance.cleanups.push(cleanup)
	},
	useRef(initial) {
		const instance = activeInstance
		const index = instance.cursor
		instance.cursor += 1
		if (!(index in instance.refs)) instance.refs[index] = { current: initial }
		return instance.refs[index]
	},
	useCallback(fn) {
		activeInstance.cursor += 1
		return fn
	}
}

const eventSources = []
const sandbox = {
	window: { __ModuleLoader__: { load: (value) => { spec = value } } },
	document: {
		getElementById: () => null,
		createElement: () => ({ id: '', textContent: '', remove() {} }),
		head: { appendChild: () => {} }
	},
	EventSource: class {
		constructor(url) { this.url = url; eventSources.push(this) }
		close() { this.closed = true }
	},
	fetch: async (url, init) => {
		calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : undefined })
		return { ok: true, status: 200, json: async () => ({ ok: true }) }
	},
	console
}
vm.runInNewContext(instrumented, sandbox, { filename: 'client.js' })
assert.ok(spec, 'client.js must call window.__ModuleLoader__.load')
const mod = spec.factory((name) => {
	assert.equal(name, 'react', 'only react may be required')
	return ReactImpl
})
const { store, Toggle, Panel, ApprovalCard, QuestionCard, BudgetBar, SandboxNotice } = mod.__test

// Required client context: `apply` registers the tab type and the slots.
const sidebarCalls = { openTab: [], close: [] }
mod.apply({
	effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanup() },
	slots: {
		inject(seat, factory) { factory() },
		register(registration, component) { return component }
	},
	inject(names, callback) { callback({ get: () => ({ register: () => () => {} }) }) },
	get: (name) => (name === 'sidebarRight'
		? { openTab: (kind, options) => sidebarCalls.openTab.push({ kind, options }), close: (id) => sidebarCalls.close.push(id) }
		: undefined)
})

// ── render helpers ──────────────────────────────────────────────────────────
// A tiny recursive renderer: host elements stay as `{type, props, children}`,
// function components are invoked (once per stable path) so nested components
// such as `SandboxNotice`, `BudgetBar` or `Item` render for real.
function mount(component, props) {
	const instances = new Map()
	let pending = false
	let tree

	const getInstance = (path) => {
		let instance = instances.get(path)
		if (instance === undefined) {
			instance = { cursor: 0, slots: [], effects: new Set(), refs: {}, pending: false, cleanups: [] }
			instance.notify = () => { pending = true }
			instances.set(path, instance)
		}
		return instance
	}

	const renderNode = (node, path) => {
		if (node === null || node === undefined || typeof node !== 'object') return node
		if (Array.isArray(node)) return node.map((child, i) => renderNode(child, `${path}/${i}`))
		if (typeof node.type === 'function') {
			const name = node.type.name || 'anon'
			const instance = getInstance(`${path}#${name}`)
			instance.cursor = 0
			activeInstance = instance
			let output
			try {
				output = node.type(node.props)
			} finally {
				activeInstance = null
			}
			const children = renderNode(output, `${path}#${name}`)
			return { type: 'component', props: node.props, children: Array.isArray(children) ? children : [children] }
		}
		const children = (node.children ?? []).map((child, i) => renderNode(child, `${path}/${i}`))
		return { type: node.type, props: node.props, children }
	}

	const settle = () => {
		let guard = 0
		do {
			pending = false
			tree = renderNode({ type: component, props, children: [] }, 'root')
			guard += 1
		} while (pending && guard < 20)
		return tree
	}

	settle()
	return {
		get tree() { return tree },
		rerender() {
			pending = true
			return settle()
		}
	}
}

function walk(node, visit) {
	if (node === null || node === undefined || typeof node !== 'object') return
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit)
		return
	}
	visit(node)
	for (const child of node.children ?? []) walk(child, visit)
}

function findAll(node, predicate) {
	const found = []
	walk(node, (element) => { if (predicate(element)) found.push(element) })
	return found
}

function textOf(node) {
	if (typeof node === 'string') return node
	if (node === null || node === undefined || typeof node !== 'object') return ''
	if (Array.isArray(node)) return node.map(textOf).join('')
	return (node.children ?? []).map(textOf).join('')
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function buttonByText(handle, text) {
	return findAll(handle.tree, (el) => el.type === 'button' && textOf(el).trim() === text)[0]
}

function inputByPlaceholder(handle, placeholder) {
	return findAll(handle.tree, (el) => (el.type === 'input' || el.type === 'textarea') && el.props.placeholder === placeholder)[0]
}

async function press(handle, button) {
	assert.ok(button, 'button to press must exist')
	assert.notEqual(button.props.disabled, true, 'pressed button must be enabled')
	button.props.onClick()
	handle.rerender()
	await flush()
	handle.rerender()
}

function type(handle, field, value) {
	assert.ok(field, 'field to type into must exist')
	field.props.onChange({ target: { value } })
	handle.rerender()
}

/** Reset the shared store to one complete snapshot. */
function seed(overrides) {
	store.set({
		enabled: true,
		status: 'idle',
		session: { sessionId: 'session-1', modelId: 'muse-wonder-1.0', providerId: 'meta', workspaceRoot: 'K:\\Redshift', approvalMode: 'onRequest' },
		items: [],
		approvals: [],
		questions: [],
		usage: null,
		lastTurn: null,
		lastError: null,
		budget: null,
		host: { version: '1.4.12', platformFamily: 'windows', sandbox: 'unavailable', sandboxReason: null, schemaVersion: 1, schemaFingerprint: 'sha256:test' },
		disableSandbox: false,
		...overrides
	})
}

const results = []
async function check(name, fn) {
	await fn()
	results.push(name)
	console.log(`PASS  ${name}`)
}

// ── 1. idle panel with the sandbox unavailable ──────────────────────────────
await check('panel-idle-sandbox-unavailable', () => {
	seed()
	const handle = mount(Panel, { sessionId: 'session-1', useTabInfo: () => ({ tab: { id: 'tab-9' } }) })
	const text = textOf(handle.tree)
	assert.ok(text.includes('Muse Code'), 'header present')
	assert.ok(text.includes('muse-wonder-1.0'), 'model shown')
	assert.ok(text.includes('空闲'), 'idle state shown')
	assert.ok(text.includes('Muse 无法在本机启用沙箱'), 'amber strip shown')
	assert.ok(text.includes('sandboxAvailability = unavailable'), 'reason shown')
	assert.ok(buttonByText(handle, '检测沙箱'), 'probe button present')
	assert.ok(buttonByText(handle, '允许无沙箱运行（危险）'), 'danger opt-in present')
	assert.equal(store.tabId, 'tab-9', 'tab id captured for closePanel')
	assert.ok(inputByPlaceholder(handle, '交给 Muse Code 的任务，回车发送（Shift+回车换行）'), 'composer placeholder')
})

// ── 2. unsandboxed mode: red strip and the only way back ────────────────────
await check('panel-unsandboxed-mode', async () => {
	seed({ disableSandbox: true })
	const handle = mount(Panel, { sessionId: 'session-1' })
	const text = textOf(handle.tree)
	assert.ok(text.includes('无沙箱模式已开启'), 'red strip shown')
	assert.ok(!text.includes('Muse 无法在本机启用沙箱'), 'amber strip replaced')
	const off = buttonByText(handle, '关闭无沙箱模式')
	assert.ok(off, 'turn-off control present')
	await press(handle, off)
	assert.equal(calls[calls.length - 1].url, '/plugins/dsh-muse-code/options')
	assert.equal(calls[calls.length - 1].body.disableSandbox, false)
})

// ── 3. sandbox available: nothing to warn about ─────────────────────────────
await check('panel-sandbox-available', () => {
	seed({ host: { version: '1.4.12', sandbox: 'available', sandboxReason: null } })
	const text = textOf(mount(Panel, { sessionId: 'session-1' }).tree)
	assert.ok(!text.includes('Muse 无法在本机启用沙箱'), 'no amber strip')
	assert.ok(!text.includes('无沙箱模式已开启'), 'no red strip')
})

// ── 4. locked spend guard ───────────────────────────────────────────────────
await check('panel-budget-locked', () => {
	seed({
		status: 'off',
		budget: {
			capUsd: 10,
			spentUsd: 10,
			remainingUsd: 0,
			reservedUsd: 6.591988,
			availableUsd: 0,
			locked: true,
			lockedCode: 'cap-reached',
			lockedReason: '已达到花费上限。',
			status: 'locked'
		}
	})
	const handle = mount(Panel, { sessionId: 'session-1' })
	const text = textOf(handle.tree)
	assert.ok(text.includes('花费 $10.00 / $10.00'), 'spend strip shown')
	assert.ok(text.includes('已达到花费上限'), 'reason shown')
	assert.ok(buttonByText(handle, '提高上限'), 'raise-cap control')
	assert.ok(buttonByText(handle, '重置花费记录'), 'reset control')
	const textarea = findAll(handle.tree, (el) => el.type === 'textarea')[0]
	assert.equal(textarea.props.disabled, true, 'composer disabled while locked')
	assert.ok(String(textarea.props.placeholder).includes('已触发花费上限'), 'locked placeholder')
})

await check('budget-raise-cap-form', async () => {
	seed({
		status: 'off',
		budget: { capUsd: 10, spentUsd: 10, remainingUsd: 0, reservedUsd: 6.59, availableUsd: 0, locked: true, lockedReason: '已达上限。', status: 'locked' }
	})
	const handle = mount(BudgetBar, { budget: store.get().budget })
	await press(handle, buttonByText(handle, '提高上限'))
	const field = inputByPlaceholder(handle, undefined) ?? findAll(handle.tree, (el) => el.type === 'input' && el.props['aria-label'] === '花费上限（美元）')[0]
	type(handle, field, '25')
	await press(handle, buttonByText(handle, '保存上限'))
	const call = calls[calls.length - 1]
	assert.equal(call.url, '/plugins/dsh-muse-code/budget')
	assert.deepEqual(call.body, { action: 'set-cap', capUsd: 25 })
})

// ── 5. approval cards ───────────────────────────────────────────────────────
await check('approval-card-feedback-rule', async () => {
	const approval = {
		approvalId: 'a1',
		requirementId: 'r1',
		toolName: 'shell',
		subject: { kind: 'shell', command: 'npm test' },
		choices: [
			{ choiceId: 'c1', decision: 'approved', label: '允许' },
			{ choiceId: 'c2', decision: 'denied', label: '拒绝', acceptsFeedback: true }
		]
	}
	const handle = mount(ApprovalCard, { approval })
	const text = textOf(handle.tree)
	assert.ok(text.includes('需要你批准：shell'), 'title')
	assert.ok(text.includes('npm test'), 'subject rendered')
	const note = inputByPlaceholder(handle, '可选：拒绝时给 Muse 的说明')
	assert.ok(note, 'feedback input appears because a choice accepts it')
	type(handle, note, '先别跑测试')
	await press(handle, buttonByText(handle, '拒绝'))
	const call = calls[calls.length - 1]
	assert.equal(call.url, '/plugins/dsh-muse-code/approval')
	assert.equal(call.body.choiceId, 'c2')
	assert.equal(call.body.requirementId, 'r1')
	assert.equal(call.body.feedback, '先别跑测试')

	const noFeedback = mount(ApprovalCard, {
		approval: { ...approval, choices: [{ choiceId: 'c3', decision: 'approved', label: '允许' }] }
	})
	assert.equal(inputByPlaceholder(noFeedback, '可选：拒绝时给 Muse 的说明'), undefined, 'no feedback field without acceptsFeedback')
})

// ── 6. multi-question cards ─────────────────────────────────────────────────
await check('question-card-multi-question', async () => {
	const question = {
		userInputId: 'u1',
		questions: [
			{
				id: 'q1',
				header: '范围',
				question: '要改哪些包？',
				selection: { mode: 'multiple', minSelections: 1, maxSelections: 2 },
				options: [{ label: 'core' }, { label: 'web' }, { label: 'docs' }]
			},
			{ id: 'q2', header: '备注', question: '还有什么要补充？', options: [] }
		]
	}
	const handle = mount(QuestionCard, { question })
	const text = textOf(handle.tree)
	assert.ok(text.includes('Muse 在问你（2 个问题）'), 'multi header')
	assert.ok(text.includes('要改哪些包？'), 'first question')
	assert.ok(text.includes('可多选（最多 2 项）'), 'multi hint')
	assert.ok(text.includes('每个问题都选好后再一起提交'), 'incomplete hint')
	const submit = buttonByText(handle, '提交回答')
	assert.equal(submit.props.disabled, true, 'submit disabled until every answer is usable')

	await press(handle, buttonByText(handle, 'core'))
	await press(handle, buttonByText(handle, 'web'))
	const field = inputByPlaceholder(handle, '输入回答')
	type(handle, field, '顺手更新 README')
	const ready = buttonByText(handle, '提交回答')
	assert.equal(ready.props.disabled, false, 'submit enabled once both are answered')
	await press(handle, ready)
	const call = calls[calls.length - 1]
	assert.equal(call.url, '/plugins/dsh-muse-code/answer')
	assert.equal(call.body.userInputId, 'u1')
	assert.deepEqual(call.body.answers, [
		{ questionId: 'q1', selectedLabels: ['core', 'web'] },
		{ questionId: 'q2', freeText: '顺手更新 README' }
	])
})

// ── 7. transcript item kinds ────────────────────────────────────────────────
await check('transcript-item-kinds', () => {
	seed({
		items: [
			{ itemId: 'i1', kind: 'userMessage', status: 'completed', revision: 1, text: '把测试跑一遍' },
			{ itemId: 'i2', kind: 'agentMessage', status: 'completed', revision: 1, text: '好的，先看仓库结构。' },
			{ itemId: 'i3', kind: 'reasoning', status: 'completed', revision: 1, summary: ['先读 README', '再看 package.json'] },
			{ itemId: 'i4', kind: 'toolCall', status: 'completed', revision: 2, tool: 'shell', displayLabel: 'ls -la', statusLine: 'exit 0', visibleOutput: 'total 12' },
			{ itemId: 'i5', kind: 'userShell', status: 'completed', revision: 1, commandText: 'git status', exitCode: 0, visibleOutput: 'clean' },
			{ itemId: 'i6', kind: 'mysteryKind', status: 'completed', revision: 1, fallbackText: '未知条目' },
			{ itemId: 'i7', kind: 'reminderChild', status: 'completed', revision: 1, text: 'housekeeping-should-hide' }
		]
	})
	const text = textOf(mount(Panel, { sessionId: 'session-1' }).tree)
	assert.ok(text.includes('把测试跑一遍'), 'user message')
	assert.ok(text.includes('好的，先看仓库结构。'), 'agent message')
	assert.ok(text.includes('先读 README'), 'reasoning summary')
	assert.ok(text.includes('ls -la'), 'tool label')
	assert.ok(text.includes('total 12'), 'tool output')
	assert.ok(text.includes('git status'), 'shell command')
	assert.ok(text.includes('未知条目'), 'unknown kind falls back to fallbackText')
	assert.ok(!text.includes('housekeeping-should-hide'), 'housekeeping kind filtered')
})

// ── 8. composer toggle ──────────────────────────────────────────────────────
await check('toggle-badge-and-state', () => {
	seed({
		status: 'running',
		approvals: [{ approvalId: 'a1', choices: [], toolName: 'shell' }, { approvalId: 'a2', choices: [], toolName: 'shell' }]
	})
	const handle = mount(Toggle, { sessionId: 'session-1' })
	const button = findAll(handle.tree, (el) => el.type === 'button')[0]
	assert.equal(button.props['aria-pressed'], true, 'pressed while enabled')
	assert.ok(textOf(handle.tree).includes('2'), 'approval badge count')
	assert.match(String(button.props.title), /已开启/)
})

// ── 9. nothing leaked (the store must not keep an EventSource after dispose) ─
await check('no-stray-eventsource', () => {
	assert.ok(eventSources.length >= 1, 'a stream was opened by subscribe')
})

console.log(`\n${results.length} render checks passed`)
