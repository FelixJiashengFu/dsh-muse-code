/**
 * Static client-half verification for dsh-muse-code.
 *
 * This is a dependency-free harness, NOT an end-to-end test: it never starts
 * Muse Code, never opens a socket and never touches the Harness host. It loads
 * `lib/client.js` in a stubbed browser (`window.__ModuleLoader__`, a minimal
 * React, a fake Client ctx) and checks the three things the browser half must
 * get right before any live smoke test:
 *
 *  1. the composer switch registers on `conversation.input.left`;
 *  2. the right-Sidebar body registers on `sidebar.right.pane.tab` with key
 *     `muse-code`, and the tab type registers as
 *     `{ id: 'muse-code', kind: 'muse-code' }`;
 *  3. every POST the panel/switch sends carries the plugin's anti-CSRF
 *     headers: `content-type: application/json` and `x-muse-code: 1`.
 *
 * Run with the bundled Node:
 *
 *   C:\Users\fujia\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe test\verify-client.mjs
 *
 * Exit code 0 = every check passed, 1 = at least one check failed or the
 * module could not be loaded.
 *
 * @module dsh-muse-code/test/verify-client
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const CLIENT_PATH = join(PACKAGE_ROOT, 'lib', 'client.js')
const INDEX_PATH = join(PACKAGE_ROOT, 'lib', 'index.js')

/** Collected check results. */
const results = []

/**
 * Record one assertion.
 * @param {string} name - what is being checked.
 * @param {boolean} passed - outcome.
 * @param {string} [detail] - extra evidence on failure.
 */
function check(name, passed, detail = '') {
	results.push({ name, passed, detail })
}

/**
 * Read a header case-insensitively from an `init.headers` value, accepting a
 * plain object or a `Headers`-like instance.
 * @param {unknown} headers - the request headers.
 * @param {string} name - header name.
 * @returns {string | undefined} the value.
 */
function headerValue(headers, name) {
	if (headers === undefined || headers === null) return undefined
	const wanted = name.toLowerCase()
	if (typeof headers === 'object' && typeof headers.get === 'function') {
		const found = headers.get(name)
		return found === null || found === undefined ? undefined : String(found)
	}
	if (typeof headers === 'object') {
		for (const key of Object.keys(headers)) {
			if (key.toLowerCase() === wanted) {
				const value = headers[key]
				return Array.isArray(value) ? value.join(',') : String(value)
			}
		}
	}
	return undefined
}

/**
 * Minimal `React.createElement` tree node.
 * @param {unknown} type - component or tag.
 * @param {object | null} props - element props.
 * @param {...unknown} children - children.
 * @returns {object} the node.
 */
function createElement(type, props, ...children) {
	const merged = { ...(props ?? {}) }
	if (children.length === 1) merged.children = children[0]
	else if (children.length > 1) merged.children = children
	return { type, props: merged }
}

/**
 * A minimal React whose hooks are synchronous and state-free: enough to call a
 * component function once and read its element tree.
 * @returns {object} the fake React module.
 */
function createFakeReact() {
	return {
		createElement,
		useState(initial) {
			return [typeof initial === 'function' ? initial() : initial, () => {}]
		},
		useRef(initial) {
			return { current: initial }
		},
		useCallback(fn) {
			return fn
		},
		useMemo(fn) {
			return fn()
		},
		useEffect(fn) {
			fn()
		},
		useLayoutEffect(fn) {
			fn()
		},
		useSyncExternalStore(subscribe, get) {
			try {
				const unsubscribe = subscribe(() => {})
				if (typeof unsubscribe === 'function') unsubscribe()
			} catch {
				/* a stub subscription failure must not hide the value check */
			}
			return get()
		}
	}
}

/**
 * Walk an element tree and collect nodes matching a predicate.
 * @param {unknown} node - tree root.
 * @param {(element: object) => boolean} predicate - match test.
 * @param {object[]} [out] - accumulator.
 * @returns {object[]} matching elements.
 */
function findElements(node, predicate, out = []) {
	if (node === null || node === undefined || typeof node !== 'object') return out
	if (Array.isArray(node)) {
		for (const child of node) findElements(child, predicate, out)
		return out
	}
	if (predicate(node)) out.push(node)
	const children = node.props?.children
	if (children !== undefined) findElements(children, predicate, out)
	return out
}

/**
 * Static checks for the $10 spending-cap surface on both halves.
 *
 * These are string-level assertions on purpose: they never import
 * `lib/budget.js`, never load the host half and never touch a Muse process, so
 * this script still cannot start `muse serve` or spend money. The behavioural
 * ledger/lock semantics are covered by the core test suites under `test/`.
 *
 * @param {string} clientSource - contents of `lib/client.js`.
 * @returns {void}
 */
function checkBudgetSurface(clientSource) {
	check('面板包含 /budget 路由调用', clientSource.includes('/budget'))
	check("面板处理 type === 'budget' 事件", /event\.type === 'budget'/.test(clientSource))
	check('面板包含 mc-budget 花费栏', clientSource.includes('mc-budget'))
	let indexSource
	try {
		indexSource = readFileSync(INDEX_PATH, 'utf8')
	} catch (error) {
		check('读取 lib/index.js', false, String(error?.message ?? error))
		return
	}
	check('Host 引入 SpendGuard', indexSource.includes('SpendGuard'))
	check('Host 使用 muse-code-spend.json 账本', indexSource.includes('muse-code-spend.json'))
	check('Host 注册 /budget 路由', indexSource.includes('${ROUTE_BASE}/budget'))
}

/**
 * Run the whole verification.
 * @returns {Promise<void>} resolves when checks are recorded.
 */
async function main() {
	let source
	try {
		source = readFileSync(CLIENT_PATH, 'utf8')
	} catch (error) {
		check('读取 lib/client.js', false, String(error?.message ?? error))
		return
	}

	// The budget surface is checked first: it is static and independent of the
	// browser harness below, so a later harness failure cannot hide it.
	checkBudgetSurface(source)

	/** Slot registrations seen by the fake ctx. */
	const slotEntries = []
	/** Tab types registered on `sidebarRightTabs`. */
	const tabTypes = []
	/** Every `fetch` call made by the loaded module. */
	const fetchCalls = []
	/** Sidebar controller calls. */
	const sidebarCalls = []
	/** Every `EventSource` the store opened. */
	const eventSources = []

	/** @type {any} */
	let loaded
	const windowStub = {
		__ModuleLoader__: {
			load(spec) {
				loaded = spec
			}
		}
	}

	// Browser globals the client half reaches for at apply/render time.
	const styleNodes = []
	globalThis.document = {
		getElementById: () => null,
		createElement: (tag) => ({ tag, id: '', textContent: '', remove() {} }),
		head: {
			appendChild(node) {
				styleNodes.push(node)
			}
		}
	}
	globalThis.EventSource = class FakeEventSource {
		constructor(url) {
			this.url = url
			this.listeners = new Map()
			eventSources.push(this)
		}
		addEventListener(name, handler) {
			const list = this.listeners.get(name) ?? []
			list.push(handler)
			this.listeners.set(name, list)
		}
		removeEventListener() {}
		close() {}
	}
	globalThis.fetch = async (path, init) => {
		fetchCalls.push({ path, init })
		return {
			ok: true,
			status: 200,
			async json() {
				return { ok: true, snapshot: { enabled: false } }
			}
		}
	}

	// Evaluate the browser module in a scope where `window` is the stub.
	try {
		// eslint-disable-next-line no-new-func
		new Function('window', source)(windowStub)
	} catch (error) {
		check('lib/client.js 可执行', false, String(error?.message ?? error))
		return
	}
	check('lib/client.js 调用 __ModuleLoader__.load', loaded !== undefined && typeof loaded.factory === 'function')
	if (loaded === undefined || typeof loaded.factory !== 'function') return
	check('模块 id 为 dsh-muse-code', loaded.id === 'dsh-muse-code', String(loaded.id))

	let exports
	try {
		exports = loaded.factory((name) => {
			if (name === 'react') return createFakeReact()
			throw new Error(`unexpected require(${JSON.stringify(name)})`)
		})
	} catch (error) {
		check('factory 可执行', false, String(error?.message ?? error))
		return
	}
	check('导出 apply/inject', typeof exports?.apply === 'function' && Array.isArray(exports?.inject))

	const services = {
		sidebarRightTabs: {
			register(definition) {
				tabTypes.push(definition)
				return () => {}
			}
		},
		sidebarRight: {
			openTab(kind, options) {
				sidebarCalls.push({ kind, options })
			},
			close(tabId) {
				sidebarCalls.push({ close: tabId })
			}
		}
	}

	const ctx = {
		effect(fn) {
			const cleanup = fn()
			return typeof cleanup === 'function' ? cleanup : () => {}
		},
		inject(_names, callback) {
			callback({
				get(name) {
					return services[name]
				}
			})
			return () => {}
		},
		get(name) {
			return services[name]
		},
		slots: {
			inject(_key, callback) {
				callback()
				return () => {}
			},
			register(options, component) {
				slotEntries.push({ ...options, component })
				return () => {}
			}
		}
	}

	try {
		exports.apply(ctx)
	} catch (error) {
		check('apply 可执行', false, String(error?.message ?? error))
		return
	}
	check('apply 可执行', true)

	// 1) The composer switch.
	const toggleEntry = slotEntries.find((entry) => entry.name === 'conversation.input.left')
	check('注册 conversation.input.left 开关', toggleEntry !== undefined && typeof toggleEntry.component === 'function')

	// 2) The right-Sidebar body and its tab type.
	const panelEntry = slotEntries.find((entry) => entry.name === 'sidebar.right.pane.tab' && entry.key === 'muse-code')
	check('注册 sidebar.right.pane.tab，key 为 muse-code', panelEntry !== undefined && typeof panelEntry.component === 'function')
	const tabType = tabTypes.find((definition) => definition?.id === 'muse-code')
	check(
		'侧栏 tab 类型为 { id: muse-code, kind: muse-code }',
		tabType !== undefined && tabType.kind === 'muse-code',
		JSON.stringify(tabTypes)
	)

	// 3) POST headers, observed through the switch click.
	if (toggleEntry === undefined || typeof toggleEntry.component !== 'function') return
	let toggleTree
	try {
		toggleTree = toggleEntry.component({ sessionId: 'verify-session' })
	} catch (error) {
		check('开关组件可渲染', false, String(error?.message ?? error))
		return
	}
	check('开关组件可渲染', true)

	const button = findElements(toggleTree, (element) => element?.type === 'button' && element?.props?.className === 'dsw-mc-toggle')[0]
	check('开关渲染出按钮', button !== undefined && typeof button?.props?.onClick === 'function')
	if (button === undefined || typeof button.props.onClick !== 'function') return

	try {
		button.props.onClick()
	} catch (error) {
		check('开关点击可执行', false, String(error?.message ?? error))
		return
	}
	check('开关点击可执行', true)

	// Let the `post()` promise chain settle (fetch is async but immediate).
	await new Promise((resolve) => setTimeout(resolve, 25))

	const postCall = fetchCalls.find((call) => String(call.path).includes('/plugins/dsh-muse-code/'))
	check('点击开关发出 POST 请求', postCall !== undefined && postCall.init?.method === 'POST', JSON.stringify(fetchCalls.map((call) => call.path)))
	if (postCall === undefined) return

	const headers = postCall.init?.headers
	const contentType = headerValue(headers, 'content-type')
	const marker = headerValue(headers, 'x-muse-code')
	check('POST 携带 content-type: application/json', typeof contentType === 'string' && contentType.toLowerCase().includes('application/json'), String(contentType))
	check('POST 携带 x-muse-code: 1（防跨站）', marker === '1', String(marker))

	// Informational: the SSE open-panel contract is covered by the live smoke
	// test; here we only report whether the module mentions it at all.
	results.push({
		name: '（提示）源码包含 open-panel 事件处理',
		passed: source.includes('open-panel'),
		detail: '此条不计入失败，SSE 行为由主 Agent 的冒烟测试验收'
	})
}

await main()

const isInfo = (entry) => entry.name.startsWith('（提示）')
const failed = results.filter((entry) => entry.passed === false && !isInfo(entry))
const passedCount = results.filter((entry) => entry.passed === true && !isInfo(entry)).length
const infoCount = results.filter(isInfo).length

for (const entry of results) {
	const status = isInfo(entry) ? 'INFO' : entry.passed === true ? 'PASS' : 'FAIL'
	const detail = entry.detail === '' || (entry.passed === true && !isInfo(entry)) ? '' : ` — ${entry.detail}`
	console.log(`[${status}] ${entry.name}${detail}`)
}
console.log(`\n${passedCount} passed, ${failed.length} failed, ${infoCount} info`)

if (failed.length > 0) {
	console.error('\nverify-client: FAILED')
	process.exitCode = 1
} else {
	console.log('verify-client: OK')
	process.exitCode = 0
}
