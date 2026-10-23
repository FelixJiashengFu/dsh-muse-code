/**
 * Browser half of the Muse Code plugin.
 *
 * Two surfaces, one state:
 *  - the on/off switch at the left of the composer, which starts/stops the
 *    Muse Code host and opens the panel;
 *  - the `muse-code` tab body of the native right Sidebar, which renders the
 *    transcript, the pending approvals/questions and its own prompt box.
 *
 * Both read the same snapshot pushed by the host over
 * `/plugins/dsh-muse-code/events` (SSE), which is what keeps the panel, the
 * switch and the chat tools on one session.
 *
 * @module dsh-muse-code/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-muse-code',
	factory: (require) => {
		const React = require('react')
		/** Short alias for `React.createElement`. */
		const h = React.createElement

		const BASE = '/plugins/dsh-muse-code'
		const SEAT = 'conversation.input.left'
		const ENTRY_ID = 'dsh-muse-code-toggle'
		const TAB_ID = 'muse-code'
		const TAB_KIND = 'muse-code'
		const STYLE_ID = 'dsh-muse-code/panel.css'

		const CSS = `
.mc-root {
	display: flex;
	flex-direction: column;
	min-height: 0;
	height: 100%;
	color: var(--dsw-alias-label-primary, inherit);
	font-size: 12.5px;
	line-height: 1.55;
}
.mc-head {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 12px;
	border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.18));
	flex: none;
}
.mc-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #999); flex: none; }
.mc-dot[data-status="running"] { background: #2fbf71; box-shadow: 0 0 0 3px rgba(47,191,113,0.18); }
.mc-dot[data-status="idle"] { background: #4f7cff; }
.mc-dot[data-status="error"] { background: #e5484d; }
.mc-dot[data-status="starting"] { background: #d9a441; }
.mc-head-title { font-weight: 600; }
.mc-head-sub { color: var(--dsw-alias-label-secondary, #888); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-head-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.mc-btn {
	display: inline-flex; align-items: center; gap: 5px;
	height: 24px; padding: 0 9px; border-radius: 6px;
	border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3));
	background: var(--dsw-alias-bg-l1, transparent);
	color: inherit; font: inherit; font-size: 11.5px; cursor: pointer; white-space: nowrap;
}
.mc-btn:hover { background: rgba(128,128,128,0.14); }
.mc-btn[data-variant="primary"] {
	border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 45%, transparent);
	background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 16%, transparent);
}
.mc-btn[data-variant="danger"] { border-color: rgba(229,72,77,0.45); color: #e5484d; background: rgba(229,72,77,0.08); }
.mc-btn:disabled { opacity: 0.5; cursor: default; }
.mc-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 12px 4px; display: flex; flex-direction: column; gap: 8px; }
.mc-empty { color: var(--dsw-alias-label-secondary, #888); padding: 18px 4px; text-align: center; }
.mc-item { display: flex; flex-direction: column; gap: 2px; }
.mc-who { font-size: 10.5px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, #999); }
.mc-bubble { white-space: pre-wrap; overflow-wrap: anywhere; }
.mc-user .mc-bubble {
	align-self: flex-end; max-width: 92%;
	background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 12%, transparent);
	border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 22%, transparent);
	border-radius: 8px; padding: 6px 9px;
}
.mc-tool {
	border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2));
	border-radius: 7px; padding: 5px 8px; background: var(--dsw-alias-bg-l1, rgba(128,128,128,0.04));
}
.mc-tool summary { cursor: pointer; color: var(--dsw-alias-label-secondary, #888); }
.mc-tool pre { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; max-height: 220px; overflow: auto; }
.mc-reasoning { color: var(--dsw-alias-label-tertiary, #999); font-size: 11.5px; }
.mc-reasoning summary { cursor: pointer; }
.mc-card {
	border: 1px solid color-mix(in srgb, #d9a441 45%, transparent);
	background: color-mix(in srgb, #d9a441 10%, transparent);
	border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px;
}
.mc-card[data-kind="question"] { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 45%, transparent); background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 8%, transparent); }
.mc-card-title { font-weight: 600; }
.mc-card-body { color: var(--dsw-alias-label-secondary, #888); white-space: pre-wrap; overflow-wrap: anywhere; }
.mc-card-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.mc-input {
	height: 26px; padding: 0 8px; border-radius: 6px;
	border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3));
	background: var(--dsw-alias-bg-l1, transparent); color: inherit; font: inherit; font-size: 12px;
	min-width: 180px; flex: 1 1 180px;
}
.mc-input:focus { outline: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 45%, transparent); outline-offset: 0; }
.mc-usage { margin-left: auto; color: var(--dsw-alias-label-tertiary, #999); font-variant-numeric: tabular-nums; }
.mc-compose { flex: none; border-top: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.18)); padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 6px; }
.mc-compose textarea {
	width: 100%; box-sizing: border-box; resize: none; min-height: 54px; max-height: 180px;
	border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3));
	background: var(--dsw-alias-bg-l1, transparent); color: inherit; font: inherit; padding: 6px 8px;
}
.mc-compose textarea:focus { outline: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 45%, transparent); outline-offset: 0; }
.mc-compose-row { display: flex; align-items: center; gap: 6px; }
.mc-hint { color: var(--dsw-alias-label-tertiary, #999); font-size: 11px; }
.mc-error { color: #e5484d; white-space: pre-wrap; }
.mc-off { padding: 24px 16px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; color: var(--dsw-alias-label-secondary, #888); }
.mc-warn {
	margin: 8px 10px 0; border-radius: 7px; padding: 7px 9px; display: flex; flex-direction: column; gap: 6px;
	border: 1px solid color-mix(in srgb, #d9a441 50%, transparent);
	background: color-mix(in srgb, #d9a441 10%, transparent);
	font-size: 11.5px; line-height: 1.45;
}
.mc-warn[data-tone="danger"] { border-color: color-mix(in srgb, #e5484d 55%, transparent); background: color-mix(in srgb, #e5484d 12%, transparent); color: #e5484d; }
.mc-warn-title { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.mc-warn-body { color: var(--dsw-alias-label-secondary, #888); overflow-wrap: anywhere; }
.mc-warn[data-tone="danger"] .mc-warn-body { color: inherit; opacity: 0.85; }
.mc-warn-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.mc-warn code { font-size: 10.5px; padding: 0 3px; border-radius: 3px; background: rgba(128,128,128,0.16); }
.mc-warn .mc-probe-out, .mc-warn .mc-probe-err {
	margin: 0; padding: 6px 8px; border-radius: 6px; max-height: 240px; overflow: auto;
	white-space: pre-wrap; overflow-wrap: anywhere;
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	font-size: 10.5px; line-height: 1.45;
	background: rgba(128,128,128,0.12);
}
.mc-warn .mc-probe-err { color: #e5484d; }
.mc-warn .mc-probe-meta { color: var(--dsw-alias-label-secondary, #888); font-variant-numeric: tabular-nums; }
.mc-budget {
	margin: 8px 10px 0; border-radius: 7px; padding: 7px 9px; display: flex; flex-direction: column; gap: 6px;
	border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22));
	background: var(--dsw-alias-bg-l1, rgba(128,128,128,0.05));
	font-size: 11.5px; line-height: 1.45;
}
.mc-budget[data-tone="warn"] { border-color: color-mix(in srgb, #d9a441 50%, transparent); background: color-mix(in srgb, #d9a441 10%, transparent); }
.mc-budget[data-tone="danger"] { border-color: color-mix(in srgb, #e5484d 55%, transparent); background: color-mix(in srgb, #e5484d 12%, transparent); color: #e5484d; }
.mc-budget-head { display: flex; align-items: baseline; gap: 8px; }
.mc-budget-title { font-weight: 600; font-variant-numeric: tabular-nums; }
.mc-budget-remain { margin-left: auto; color: var(--dsw-alias-label-secondary, #888); font-variant-numeric: tabular-nums; }
.mc-budget[data-tone="danger"] .mc-budget-remain { color: inherit; opacity: 0.85; }
.mc-budget-track { height: 5px; border-radius: 3px; overflow: hidden; background: rgba(128,128,128,0.18); }
.mc-budget-fill { height: 100%; border-radius: 3px; background: var(--dsw-alias-brand-primary, #4f7cff); transition: width 160ms ease; }
.mc-budget[data-tone="warn"] .mc-budget-fill { background: #d9a441; }
.mc-budget[data-tone="danger"] .mc-budget-fill { background: #e5484d; }
.mc-budget-sub { color: var(--dsw-alias-label-tertiary, #999); }
.mc-budget-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.mc-budget-form { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.mc-budget-form .mc-input { flex: 0 1 150px; min-width: 110px; }
.mc-budget-hint { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--dsw-alias-label-tertiary, #999); }

.dsw-mc-toggle {
	display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 9px 0 7px;
	border-radius: 7px; border: 1px solid transparent; background: transparent; color: inherit;
	font: inherit; font-size: 12px; line-height: 1; cursor: pointer; white-space: nowrap;
	opacity: 0.72; transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease, border-color 120ms ease;
	-webkit-app-region: no-drag;
}
.dsw-mc-toggle:hover { opacity: 1; background: rgba(128,128,128,0.16); }
.dsw-mc-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4f7cff); outline-offset: 1px; }
.dsw-mc-toggle[data-state="on"] {
	opacity: 1; color: var(--dsw-alias-brand-primary, #4f7cff);
	background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 14%, transparent);
	border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 34%, transparent);
}
.dsw-mc-toggle[data-state="on"]:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 22%, transparent); }
.dsw-mc-toggle[data-state="error"] { opacity: 1; color: #e5484d; border-color: rgba(229,72,77,0.5); background: rgba(229,72,77,0.1); }
.dsw-mc-toggle[data-busy="true"] { cursor: progress; opacity: 0.85; }
.dsw-mc-toggle svg { flex: none; display: block; }
.dsw-mc-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: 0.45; flex: none; }
.dsw-mc-toggle[data-state="on"] .dsw-mc-dot { opacity: 1; box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary, #4f7cff) 26%, transparent); }
.dsw-mc-badge {
	min-width: 15px; height: 15px; padding: 0 4px; border-radius: 8px; background: #d9a441; color: #1b1300;
	font-size: 10px; line-height: 15px; text-align: center; font-weight: 700;
}
.dsw-mc-spinner { width: 11px; height: 11px; border-radius: 50%; border: 1.5px solid color-mix(in srgb, currentColor 30%, transparent); border-top-color: currentColor; animation: dsw-mc-spin 720ms linear infinite; flex: none; }
@keyframes dsw-mc-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dsw-mc-spinner { animation-duration: 2s; } }
`

		// ── shared state ───────────────────────────────────────────────────────

		/**
		 * Fold a streamed delta into an item, exactly like the host does.
		 * @param {object} item - the item to mutate.
		 * @param {string} field - dotted field path.
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
				target[Number(last)] = String(target[Number(last)] ?? '') + delta
				return
			}
			target[last] = String(target[last] ?? '') + delta
		}

		/** Housekeeping item kinds the panel does not show. */
		const HIDDEN_KINDS = new Set(['reminderChild', 'hookRun', 'monitorFeed', 'scheduledFire', 'damagedRange'])

		/** One snapshot shared by the toggle and the panel. */
		const store = {
			snapshot: {
				enabled: false,
				status: 'off',
				session: null,
				items: [],
				approvals: [],
				questions: [],
				usage: null,
				lastTurn: null,
				lastError: null,
				budget: null
			},
			listeners: new Set(),
			source: undefined,
			opening: false,
			tabId: undefined,
			openPanel: () => {},
			closePanel: () => {},

			/** @returns {object} the current snapshot. */
			get() { return this.snapshot },

			/**
			 * Subscribe a React component to snapshot changes.
			 * @param {Function} fn - listener.
			 * @returns {Function} unsubscribe.
			 */
			subscribe(fn) {
				this.listeners.add(fn)
				this.connect()
				return () => { this.listeners.delete(fn) }
			},

			/** @param {object} next - replacement snapshot. */
			set(next) {
				this.snapshot = next
				for (const fn of [...this.listeners]) fn(next)
			},

			/** @param {object} patch - shallow patch. */
			patch(patch) {
				this.set({ ...this.snapshot, ...patch })
			},

			/** Open the SSE stream once. */
			connect() {
				if (this.source !== undefined) return
				const source = new EventSource(BASE + '/events')
				this.source = source
				source.onmessage = (message) => {
					let payload
					try { payload = JSON.parse(message.data) } catch { return }
					this.apply(payload)
				}
			},

			/**
			 * Apply one host event.
			 * @param {object} event - `{type, ...}` payload.
			 */
			apply(event) {
				const current = this.snapshot
				if (event.type === 'snapshot') {
					const next = { ...current, ...event.snapshot }
					const wasEnabled = current.enabled
					this.set(next)
					if (next.enabled && !wasEnabled && this.opening === false) this.openPanel()
					return
				}
				if (event.type === 'open-panel') {
					this.openPanel()
					return
				}
				if (event.type === 'enabled') {
					const wasEnabled = current.enabled
					this.patch({ enabled: event.enabled, lastError: event.enabled ? null : current.lastError })
					if (event.enabled && !wasEnabled) this.openPanel()
					if (!event.enabled) this.closePanel()
					return
				}
				if (event.type === 'status') {
					if (event.status === 'off') {
						// A closed session must not leave a stale switch, a stale
						// transcript or stale approval cards on screen.
						this.patch({
							status: 'off',
							enabled: false,
							session: null,
							approvals: [],
							questions: [],
							lastError: event.error ?? null
						})
						return
					}
					this.patch({ status: event.status, lastError: event.error ?? current.lastError })
					return
				}
				if (event.type === 'usage') { this.patch({ usage: event.usage }); return }
				if (event.type === 'budget') { this.patch({ budget: event.budget }); return }
				if (event.type === 'turn') {
					const terminal = event.turn === null || event.turn === undefined ? undefined : event.turn.terminal
					this.patch({ lastTurn: event.turn, lastError: terminal === 'completed' ? null : current.lastError })
					return
				}
				if (event.type === 'item') {
					const items = current.items.slice()
					const at = items.findIndex((item) => item.itemId === event.item.itemId)
					if (at >= 0) items[at] = event.item
					else items.push(event.item)
					this.patch({ items })
					return
				}
				if (event.type === 'delta') {
					const items = current.items.slice()
					const at = items.findIndex((item) => item.itemId === event.itemId)
					if (at < 0) return
					const copy = { ...items[at] }
					applyDelta(copy, event.field, event.delta)
					items[at] = copy
					this.patch({ items })
					return
				}
				if (event.type === 'approval') {
					const approvals = current.approvals.filter((entry) => entry.approvalId !== event.approval.approvalId)
					approvals.push(event.approval)
					this.patch({ approvals })
					return
				}
				if (event.type === 'approval-resolved') {
					this.patch({ approvals: current.approvals.filter((entry) => entry.approvalId !== event.approvalId) })
					return
				}
				if (event.type === 'question') {
					const questions = current.questions.filter((entry) => entry.userInputId !== event.question.userInputId)
					questions.push(event.question)
					this.patch({ questions })
					return
				}
				if (event.type === 'question-settled') {
					this.patch({ questions: current.questions.filter((entry) => entry.userInputId !== event.userInputId) })
				}
			}
		}

		/**
		 * POST a JSON body to one plugin route.
		 *
		 * Every mutating request carries the same two markers the host checks
		 * before it will act: `content-type: application/json` and the
		 * `x-muse-code: 1` header (a plain HTML form or a cross-site fetch
		 * cannot produce both). There is no other fetch path in this module.
		 *
		 * @param {string} path - route path.
		 * @param {object} body - payload.
		 * @returns {Promise<object>} decoded reply.
		 */
		async function post(path, body) {
			const response = await fetch(path, {
				method: 'POST',
				credentials: 'same-origin',
				cache: 'no-store',
				headers: {
					'content-type': 'application/json',
					'x-muse-code': '1'
				},
				body: JSON.stringify(body ?? {})
			})
			const payload = await response.json().catch(() => ({}))
			if (!response.ok || payload?.ok !== true) {
				throw new Error(String(payload?.error ?? `HTTP ${response.status}`))
			}
			return payload
		}

		/**
		 * Format a USD amount exactly like the host's `formatUsd`, so the panel
		 * and the chat tools never disagree on the same ledger number.
		 * @param {number} value - amount in dollars.
		 * @returns {string} display text.
		 */
		function usd(value) {
			const amount = Number(value)
			if (!Number.isFinite(amount)) return '$?'
			return Math.abs(amount) < 0.01 && amount !== 0 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`
		}

		// ── the composer switch ───────────────────────────────────────────────

		/** @returns {object} the Muse glyph. */
		function Glyph() {
			return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none' },
				h('path', { d: 'M2.6 13V4.2c0-.7.8-1 1.3-.55L8 7.9l4.1-4.25c.5-.52 1.3-.15 1.3.55V13', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
				h('circle', { cx: 13.1, cy: 12.4, r: 1.2, fill: 'currentColor' })
			)
		}

		/**
		 * Subscribe to the shared snapshot.
		 * @returns {object} the current snapshot.
		 */
		function useSnapshot() {
			const [value, setValue] = React.useState(store.get())
			React.useEffect(() => {
				setValue(store.get())
				return store.subscribe(setValue)
			}, [])
			return value
		}

		/**
		 * The on/off switch.
		 * @returns {object} React element.
		 */
		function Toggle(props) {
			const snapshot = useSnapshot()
			const [busy, setBusy] = React.useState(false)
			const [error, setError] = React.useState('')
			const on = snapshot.enabled === true
			const approvals = snapshot.approvals.length
			const sessionId = props === undefined || props === null ? undefined : props.sessionId

			React.useEffect(() => {
				store.openPanel = () => openPanel()
				store.closePanel = () => closePanel()
				if (snapshot.enabled) openPanel()
			}, [])

			const flip = React.useCallback(() => {
				if (busy) return
				const next = !on
				setBusy(true)
				setError('')
				post(BASE + '/enable', { enabled: next, sessionId })
					.then((payload) => {
						const body = payload?.snapshot
						if (body !== undefined) store.set({ ...store.get(), ...body })
						if (next) openPanel()
						else closePanel()
					})
					.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
					.finally(() => setBusy(false))
			}, [busy, on, sessionId])

			const state = busy ? 'unknown' : error !== '' ? 'error' : on ? 'on' : 'off'
			const title = busy
				? '正在启动 Muse Code…'
				: error !== ''
					? `Muse Code 开关失败：${error}`
					: on
						? 'Muse Code 已开启：右侧边栏显示实时会话。点击关闭。'
						: 'Muse Code 已关闭。点击开启，在右侧边栏使用 Muse Code。'

			return h('button', {
				type: 'button',
				className: 'dsw-mc-toggle',
				'data-state': state,
				'data-busy': busy ? 'true' : 'false',
				'aria-pressed': on,
				title,
				onClick: flip
			},
				busy ? h('span', { className: 'dsw-mc-spinner' }) : h(Glyph),
				h('span', null, 'Muse'),
				approvals > 0 ? h('span', { className: 'dsw-mc-badge' }, String(approvals)) : h('span', { className: 'dsw-mc-dot' })
			)
		}

		// ── the right-sidebar panel ───────────────────────────────────────────

		/**
		 * One readable line for an approval subject.
		 * @param {object} subject - `ApprovalSubject`.
		 * @returns {string} label.
		 */
		function subjectText(subject) {
			if (subject === undefined || subject === null) return '未知操作'
			const what = subject.kind === 'shell'
				? subject.command
				: subject.kind === 'fileAccess'
					? subject.path
					: subject.kind === 'network'
						? [subject.host, subject.port].filter((part) => part !== undefined).join(':')
						: subject.target ?? subject.toolName ?? subject.path ?? ''
			return String(what ?? subject.kind ?? '')
		}

		/**
		 * One transcript row.
		 * @param {object} props - item.
		 * @returns {object} React element.
		 */
		function Item({ item }) {
			if (HIDDEN_KINDS.has(item.kind)) return null
			if (item.kind === 'userMessage') {
				return h('div', { className: 'mc-item mc-user' },
					h('div', { className: 'mc-bubble' }, String(item.text ?? ''))
				)
			}
			if (item.kind === 'agentMessage') {
				return h('div', { className: 'mc-item' },
					h('div', { className: 'mc-who' }, item.status === 'inProgress' ? 'Muse · 生成中' : 'Muse'),
					h('div', { className: 'mc-bubble' }, String(item.text ?? ''))
				)
			}
			if (item.kind === 'reasoning') {
				const text = String(item.text ?? '') || (Array.isArray(item.summary) ? item.summary.join('\n') : '')
				if (text === '') return null
				return h('details', { className: 'mc-reasoning' },
					h('summary', null, '思考过程'),
					h('div', { className: 'mc-bubble' }, text)
				)
			}
			if (item.kind === 'toolCall') {
				const out = String(item.visibleOutput ?? '')
				return h('details', { className: 'mc-tool' },
					h('summary', null,
						`🔧 ${String(item.displayLabel ?? item.tool ?? 'tool')} · ${String(item.status === 'inProgress' ? '运行中' : item.status ?? '')}`,
						item.statusLine === undefined ? '' : ` — ${String(item.statusLine)}`
					),
					out === '' ? null : h('pre', null, out)
				)
			}
			if (item.kind === 'userShell') {
				return h('div', { className: 'mc-tool' },
					h('div', null, `$ ${String(item.commandText ?? '')}`),
					item.exitCode === undefined ? null : h('div', { className: 'mc-who' }, `exit ${String(item.exitCode)}`),
					item.visibleOutput === undefined ? null : h('pre', null, String(item.visibleOutput))
				)
			}
			if (item.kind === 'compaction') return h('div', { className: 'mc-who' }, '— 上下文已压缩 —')
			const text = String(item.fallbackText ?? item.text ?? '')
			if (text === '') return null
			return h('div', { className: 'mc-item' },
				h('div', { className: 'mc-who' }, String(item.kind)),
				h('div', { className: 'mc-bubble' }, text)
			)
		}

		/**
		 * The approval card: the only place a Muse approval can be decided.
		 * @param {object} props - approval record.
		 * @returns {object} React element.
		 */
		function ApprovalCard({ approval }) {
			const [busy, setBusy] = React.useState('')
			const [error, setError] = React.useState('')
			const [note, setNote] = React.useState('')
			const choices = Array.isArray(approval.choices) ? approval.choices : []
			const acceptsFeedback = choices.some((choice) => choice.acceptsFeedback === true)

			const decide = (choice) => {
				setBusy(choice.choiceId)
				setError('')
				post(BASE + '/approval', {
					approvalId: approval.approvalId,
					choiceId: choice.choiceId,
					requirementId: approval.requirementId,
					// The note is denial guidance: MSP only accepts it on a
					// choice that declares `acceptsFeedback`, so a note typed
					// next to an approve button is never sent.
					feedback: choice.acceptsFeedback === true && note !== '' ? note : undefined
				}).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(''))
			}

			return h('div', { className: 'mc-card' },
				h('div', { className: 'mc-card-title' }, `需要你批准：${String(approval.toolName ?? '')}`),
				h('div', { className: 'mc-card-body' }, subjectText(approval.subject)),
				acceptsFeedback ? h('input', {
					className: 'mc-input',
					placeholder: '可选：拒绝时给 Muse 的说明',
					value: note,
					onChange: (event) => setNote(event.target.value)
				}) : null,
				h('div', { className: 'mc-card-actions' },
					...choices.map((choice) => h('button', {
						key: choice.choiceId,
						type: 'button',
						className: 'mc-btn',
						'data-variant': String(choice.decision ?? '').startsWith('denied') ? 'danger' : 'primary',
						disabled: busy !== '',
						onClick: () => decide(choice)
					}, busy === choice.choiceId ? '提交中…' : String(choice.label ?? choice.decision)))
				),
				error === '' ? null : h('div', { className: 'mc-error' }, error)
			)
		}

		/**
		 * The question card: the only place a Muse question can be answered.
		 *
		 * MSP sends every question of one request together and expects every
		 * answer back in a single `userInput/answer` call. The card therefore
		 * collects one answer per question (single label, multiple labels, or
		 * free text) and only enables Submit once all of them are usable. A
		 * failed POST keeps every selection and every typed character, so the
		 * user can retry without re-entering anything.
		 *
		 * @param {object} props - question record.
		 * @returns {object} React element.
		 */
		function QuestionCard({ question }) {
			const [busy, setBusy] = React.useState(false)
			const [error, setError] = React.useState('')
			const [answers, setAnswers] = React.useState({})
			const questions = Array.isArray(question.questions) ? question.questions : []

			/** Store one question's draft answer. */
			const setAnswer = (id, value) => setAnswers((previous) => ({ ...previous, [id]: value }))

			/** @returns {boolean} whether this question accepts several labels. */
			const multipleOf = (entry) => entry?.selection?.mode === 'multiple' && (entry.options ?? []).length > 0

			/** @returns {number} the declared minimum number of selections. */
			const minimumOf = (entry) => {
				const declared = entry?.selection?.minSelections
				return typeof declared === 'number' && declared >= 0 ? declared : 1
			}

			/** @returns {number|undefined} the declared maximum number of selections. */
			const maximumOf = (entry) => {
				const declared = entry?.selection?.maxSelections
				return typeof declared === 'number' && declared > 0 ? declared : undefined
			}

			/** @returns {boolean} whether one question already has a usable answer. */
			const answered = (entry) => {
				const answer = answers[entry.id]
				if (answer === undefined) return false
				if (answer.kind === 'multiple') return answer.labels.length >= minimumOf(entry)
				if (answer.kind === 'text') return answer.value.trim() !== ''
				return typeof answer.label === 'string' && answer.label !== ''
			}

			const complete = questions.length > 0 && questions.every(answered)

			/** Pick or toggle one option, never exceeding `selection.maxSelections`. */
			const choose = (entry, option) => {
				if (busy) return
				if (!multipleOf(entry)) {
					setAnswer(entry.id, { kind: 'single', label: option.label })
					return
				}
				const current = answers[entry.id]?.kind === 'multiple' ? answers[entry.id].labels : []
				const selected = current.includes(option.label)
				const next = selected ? current.filter((label) => label !== option.label) : [...current, option.label]
				const limit = maximumOf(entry)
				if (!selected && limit !== undefined && next.length > limit) return
				setAnswer(entry.id, { kind: 'multiple', labels: next })
			}

			/** @returns {boolean} whether one option is currently picked. */
			const picked = (entry, option) => {
				const answer = answers[entry.id]
				if (answer === undefined) return false
				if (answer.kind === 'multiple') return answer.labels.includes(option.label)
				return answer.kind === 'single' && answer.label === option.label
			}

			/** Submit every answer at once, as MSP requires. */
			const submit = () => {
				if (busy || !complete) return
				const payload = questions.map((entry) => {
					const answer = answers[entry.id]
					if (answer.kind === 'multiple') return { questionId: entry.id, selectedLabels: answer.labels }
					if (answer.kind === 'text') return { questionId: entry.id, freeText: answer.value.trim() }
					return { questionId: entry.id, selectedLabel: answer.label }
				})
				setBusy(true)
				setError('')
				post(BASE + '/answer', { userInputId: question.userInputId, answers: payload })
					.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
					.finally(() => setBusy(false))
			}

			return h('div', { className: 'mc-card', 'data-kind': 'question' },
				h('div', { className: 'mc-card-title' }, questions.length > 1 ? `Muse 在问你（${questions.length} 个问题）` : 'Muse 在问你'),
				...questions.map((entry) => {
					const multiple = multipleOf(entry)
					const limit = maximumOf(entry)
					const hint = (entry.options ?? []).length === 0
						? ''
						: multiple
							? `可多选${limit === undefined ? '' : `（最多 ${limit} 项）`}`
							: '单选'
					return h('div', { key: entry.id, className: 'mc-card' },
						h('div', { className: 'mc-card-body' }, `${entry.header ?? ''} ${entry.question ?? ''}`.trim()),
						hint === '' ? null : h('div', { className: 'mc-who' }, hint),
						(entry.options ?? []).length > 0
							? h('div', { className: 'mc-card-actions' },
								...(entry.options ?? []).map((option) => h('button', {
									key: option.label,
									type: 'button',
									className: 'mc-btn',
									'data-variant': picked(entry, option) ? 'primary' : undefined,
									'aria-pressed': picked(entry, option),
									disabled: busy,
									onClick: () => choose(entry, option)
								}, String(option.label)))
							)
							: h('div', { className: 'mc-card-actions' },
								h('input', {
									className: 'mc-input',
									placeholder: '输入回答',
									value: answers[entry.id]?.kind === 'text' ? answers[entry.id].value : '',
									onChange: (event) => setAnswer(entry.id, { kind: 'text', value: event.target.value }),
									onKeyDown: (event) => {
										if (event.key !== 'Enter') return
										event.preventDefault()
										submit()
									}
								})
							)
					)
				}),
				h('div', { className: 'mc-card-actions' },
					h('button', {
						type: 'button',
						className: 'mc-btn',
						'data-variant': 'primary',
						disabled: busy || !complete,
						onClick: submit
					}, busy ? '提交中…' : '提交回答'),
					complete || questions.length === 0 ? null : h('span', { className: 'mc-hint' }, '每个问题都选好后再一起提交')
				),
				error === '' ? null : h('div', { className: 'mc-error' }, error)
			)
		}

		/**
		 * The spend strip: spent / cap, the worst-case reserve held for the next
		 * call, and — once the cap latches — the only two controls that can lift
		 * it (raise the cap, or reset the ledger). It deliberately renders in
		 * both panel states: a locked guard also turns the switch off, so the
		 * unlock form has to stay reachable while the panel says "已关闭".
		 * @param {object} props - `budget` snapshot (or null before the first push).
		 * @returns {object|null} React element, or null while the guard is unknown.
		 */
		function BudgetBar({ budget }) {
			const [form, setForm] = React.useState('')
			const [capDraft, setCapDraft] = React.useState('')
			const [confirmDraft, setConfirmDraft] = React.useState('')
			const [busy, setBusy] = React.useState('')
			const [error, setError] = React.useState('')

			if (budget === null || budget === undefined) return null

			const locked = budget.locked === true
			const cap = Number(budget.capUsd ?? 0)
			const spent = Number(budget.spentUsd ?? 0)
			const remaining = Number(budget.remainingUsd ?? 0)
			const reserved = Number(budget.reservedUsd ?? 0)
			const ratio = cap > 0 ? Math.max(0, Math.min(1, spent / cap)) : 0
			const tone = locked ? 'danger' : budget.status === 'near' ? 'warn' : 'ok'

			/**
			 * Send one guard mutation and fold its reply into the shared store.
			 * @param {string} action - the action being sent, for the busy label.
			 * @param {object} payload - request body.
			 */
			const submit = (action, payload) => {
				if (busy !== '') return
				setBusy(action)
				setError('')
				post(BASE + '/budget', payload)
					.then((reply) => {
						if (reply?.budget !== undefined) store.patch({ budget: reply.budget })
						setForm('')
						setCapDraft('')
						setConfirmDraft('')
					})
					.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
					.finally(() => setBusy(''))
			}

			const openCap = () => {
				if (form === 'cap') { setForm(''); return }
				setCapDraft(String(cap))
				setError('')
				setForm('cap')
			}

			const saveCap = () => {
				const value = Number(capDraft)
				if (!Number.isFinite(value) || value <= 0 || value > 100000) {
					setError('上限必须是 0 到 100000 之间的数字')
					return
				}
				submit('set-cap', { action: 'set-cap', capUsd: value })
			}

			const doReset = () => {
				if (confirmDraft.trim().toUpperCase() !== 'RESET') {
					setError('请输入 RESET 确认重置')
					return
				}
				submit('reset', { action: 'reset', confirm: true })
			}

			return h('div', { className: 'mc-budget', 'data-tone': tone },
				h('div', { className: 'mc-budget-head' },
					h('span', { className: 'mc-budget-title' }, `花费 ${usd(spent)} / ${usd(cap)}`),
					h('span', { className: 'mc-budget-remain' }, `剩余 ${usd(remaining)}`)
				),
				h('div', { className: 'mc-budget-track' },
					h('div', { className: 'mc-budget-fill', style: { width: `${Math.round(ratio * 10000) / 100}%` } })
				),
				h('div', { className: 'mc-budget-sub' }, `安全预留 ${usd(reserved)}（下一次调用最坏成本）`),
				locked ? h('div', { className: 'mc-warn-body' }, `${String(budget.lockedReason ?? '已达到花费上限').replace(/。+$/, '')}。达到上限后 Muse Code 已强制停止，绝不再发起模型调用。`) : null,
				locked
					? h('div', { className: 'mc-budget-actions' },
						h('button', { type: 'button', className: 'mc-btn', 'data-variant': 'primary', disabled: busy !== '', onClick: openCap }, form === 'cap' ? '收起上限设置' : '提高上限'),
						h('button', { type: 'button', className: 'mc-btn', 'data-variant': 'danger', disabled: busy !== '', onClick: () => { setForm(form === 'reset' ? '' : 'reset'); setError('') } }, form === 'reset' ? '收起重置' : '重置花费记录')
					)
					: h('div', { className: 'mc-budget-hint' },
						h('span', null, `上限 ${usd(cap)}`),
						h('button', { type: 'button', className: 'mc-btn', disabled: busy !== '', onClick: openCap }, form === 'cap' ? '收起' : '调整上限')
					),
				form === 'cap'
					? h('div', { className: 'mc-budget-form' },
						h('input', {
							className: 'mc-input',
							type: 'number',
							step: '0.01',
							min: '0.01',
							'aria-label': '花费上限（美元）',
							value: capDraft,
							onChange: (event) => setCapDraft(event.target.value)
						}),
						h('button', { type: 'button', className: 'mc-btn', 'data-variant': 'primary', disabled: busy !== '', onClick: saveCap }, busy === 'set-cap' ? '保存中…' : '保存上限'),
						h('button', { type: 'button', className: 'mc-btn', disabled: busy !== '', onClick: () => setForm('') }, '取消')
					)
					: null,
				form === 'reset'
					? h('div', { className: 'mc-budget-form' },
						h('input', {
							className: 'mc-input',
							type: 'text',
							placeholder: '输入 RESET 确认',
							'aria-label': '重置确认',
							value: confirmDraft,
							onChange: (event) => setConfirmDraft(event.target.value)
						}),
						h('button', { type: 'button', className: 'mc-btn', 'data-variant': 'danger', disabled: busy !== '', onClick: doReset }, busy === 'reset' ? '重置中…' : '确认重置'),
						h('button', { type: 'button', className: 'mc-btn', disabled: busy !== '', onClick: () => setForm('') }, '取消')
					)
					: null,
				h('div', { className: 'mc-hint' }, '这是硬性上限：达到后自动强制停止 Muse Code，不会再有新的模型调用。它管不到你手动在终端里运行的 muse。'),
				error === '' ? null : h('div', { className: 'mc-error' }, error)
			)
		}

		/**
		 * The output of one read-only `muse sandbox windows check`, rendered as a
		 * monospace block: the command's own words, never a summary of them.
		 * @param {object} props - `{ probe }`.
		 * @returns {object|null} React element, or null while idle.
		 */
		function SandboxProbeOutput({ probe }) {
			if (probe === null || probe === undefined) return null
			if (probe.phase === 'running') {
				return h('div', { className: 'mc-warn-body' }, '正在运行 muse sandbox windows check（只读，最长 20 秒）…')
			}
			if (probe.phase === 'error') {
				return h('div', { className: 'mc-error' }, probe.message)
			}
			const meta = probe.exitCode === null || probe.exitCode === undefined
				? '命令已结束（未报告退出码）'
				: `退出码 ${probe.exitCode}`
			const empty = probe.stdout === '' && probe.stderr === ''
			return h('div', { className: 'mc-warn-body' },
				h('div', { className: 'mc-probe-meta' }, `${meta}${typeof probe.durationMs === 'number' ? ` · ${probe.durationMs} ms` : ''}`),
				probe.stdout === '' ? null : h('pre', { className: 'mc-probe-out' }, probe.stdout),
				probe.stderr === '' ? null : h('pre', { className: 'mc-probe-err' }, probe.stderr),
				empty ? h('div', null, '（命令没有输出）') : null
			)
		}

		/**
		 * The sandbox posture strip. This is the only surface that can flip the
		 * unsandboxed mode: no Muse tool and no agent-facing route reaches it.
		 *
		 * It also carries the read-only diagnostic: the panel can run
		 * `muse sandbox windows check` and show its raw output, because that
		 * check and the `serve` runtime verdict are two different decisions.
		 * @returns {object|null} React element, or null when nothing is wrong.
		 */
		function SandboxNotice() {
			const snapshot = useSnapshot()
			const [confirming, setConfirming] = React.useState(false)
			const [busy, setBusy] = React.useState(false)
			const [error, setError] = React.useState('')
			// `null` until the user runs the check; then `{ phase, … }`.
			const [probe, setProbe] = React.useState(null)
			const host = snapshot.host

			const apply = (next) => {
				setBusy(true)
				setError('')
				post(BASE + '/options', { disableSandbox: next })
					.then(() => { setConfirming(false) })
					.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
					.finally(() => setBusy(false))
			}

			const runProbe = () => {
				if (probe !== null && probe.phase === 'running') return
				setProbe({ phase: 'running' })
				post(BASE + '/sandbox-check', {})
					.then((payload) => setProbe({
						phase: 'done',
						stdout: String(payload?.stdout ?? ''),
						stderr: String(payload?.stderr ?? ''),
						exitCode: typeof payload?.exitCode === 'number' ? payload.exitCode : null,
						durationMs: typeof payload?.durationMs === 'number' ? payload.durationMs : undefined,
						passed: payload?.passed === true
					}))
					.catch((reason) => setProbe({ phase: 'error', message: reason instanceof Error ? reason.message : String(reason) }))
			}

			if (host === null || host === undefined) return null

			if (snapshot.disableSandbox === true) {
				return h('div', { className: 'mc-warn', 'data-tone': 'danger' },
					h('div', { className: 'mc-warn-title' }, '无沙箱模式已开启'),
					h('div', { className: 'mc-warn-body' }, 'Muse 的命令会直接执行，也不会逐条请求审批。只在你信任当前任务时保持开启。'),
					h('div', { className: 'mc-warn-actions' },
						h('button', { type: 'button', className: 'mc-btn', disabled: busy, onClick: () => apply(false) }, busy ? '切换中…' : '关闭无沙箱模式')
					),
					error === '' ? null : h('div', { className: 'mc-error' }, error)
				)
			}

			if (host.sandbox === 'available') return null

			const reason = host.sandboxReason === null || host.sandboxReason === undefined ? '' : ` (${host.sandboxReason})`
			const running = probe !== null && probe.phase === 'running'
			return h('div', { className: 'mc-warn' },
				h('div', { className: 'mc-warn-title' }, 'Muse 无法在本机启用沙箱'),
				h('div', { className: 'mc-warn-body' },
					`sandboxAvailability = ${String(host.sandbox ?? 'unavailable')}${reason}：Muse 的 shell 工具会直接失败。`
				),
				h('div', { className: 'mc-warn-body' },
					'「检测沙箱」会运行只读的 ',
					h('code', null, 'muse sandbox windows check'),
					' 并原样显示输出；修复安装产物请运行 ',
					h('code', null, 'muse sandbox windows setup'),
					'。'
				),
				h('div', { className: 'mc-warn-body' },
					'注意：check 校验的是安装产物（backend / runner_trusted / sandbox_users_ready / wfp_ready 等）；',
					'serve 在 initialize 时会按运行时判定另算一次 sandboxAvailability，二者可能不一致——check 全绿也不等于 serve 可用。'
				),
				h(SandboxProbeOutput, { probe }),
				confirming
					? h('div', { className: 'mc-warn-actions' },
						h('span', { className: 'mc-warn-body' }, '开启后没有沙箱，命令会直接执行且不逐条审批。确定吗？'),
						h('button', { type: 'button', className: 'mc-btn', 'data-variant': 'danger', disabled: busy, onClick: () => apply(true) }, busy ? '切换中…' : '确认开启（危险）'),
						h('button', { type: 'button', className: 'mc-btn', disabled: busy, onClick: () => setConfirming(false) }, '取消')
					)
					: h('div', { className: 'mc-warn-actions' },
						h('button', { type: 'button', className: 'mc-btn', disabled: running, onClick: runProbe }, running ? '检测中…' : '检测沙箱'),
						h('button', { type: 'button', className: 'mc-btn', onClick: () => setConfirming(true) }, '允许无沙箱运行（危险）')
					),
				error === '' ? null : h('div', { className: 'mc-error' }, error)
			)
		}

		/**
		 * The tab body.
		 * @param {object} props - injected props (`sessionId`, `useTabInfo`).
		 * @returns {object} React element.
		 */
		function Panel(props) {
			const snapshot = useSnapshot()
			const [draft, setDraft] = React.useState('')
			const [sending, setSending] = React.useState(false)
			const [error, setError] = React.useState('')
			const scroller = React.useRef(null)

			// `useTabInfo` is injected by the sidebar framework. The fallback
			// keeps the hook order stable if the panel is ever mounted outside
			// a tab: the hook itself is always called, never conditionally.
			const useTabInfo = props.useTabInfo ?? (() => undefined)
			const info = useTabInfo()
			React.useEffect(() => {
				store.tabId = info?.tab?.id
			}, [info?.tab?.id])

			const items = snapshot.items
			const budget = snapshot.budget
			const locked = budget !== null && budget !== undefined && budget.locked === true
			const running = snapshot.status === 'running'
			React.useEffect(() => {
				const node = scroller.current
				if (node === null) return
				node.scrollTop = node.scrollHeight
			}, [items, snapshot.approvals.length, snapshot.questions.length])

			const send = () => {
				const text = draft.trim()
				if (text === '' || sending || locked) return
				setSending(true)
				setError('')
				// Running: insert the message into the live turn (steer).
				// Idle: queue a new turn. The host maps this to `ifBusy`.
				post(BASE + '/prompt', { text, steer: running, sessionId: props.sessionId })
					.then(() => { setDraft(''); store.patch({ lastError: null }) })
					.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
					.finally(() => setSending(false))
			}

			if (snapshot.enabled !== true) {
				return h('div', { className: 'mc-root' },
					h('div', { className: 'mc-head' },
						h('span', { className: 'mc-dot', 'data-status': snapshot.status }),
						h('span', { className: 'mc-head-title' }, 'Muse Code'),
						h('span', { className: 'mc-head-sub' }, '已关闭')
					),
					h(BudgetBar, { budget }),
					h('div', { className: 'mc-off' },
						h('div', null, locked ? '花费上限已锁定，Muse Code 已强制停止。' : 'Muse Code 开关是关闭的。'),
						h('div', null, locked ? '先在上方提高上限或重置花费记录，再打开输入框左侧的「Muse」开关。' : '打开输入框左侧的「Muse」开关，这个面板就会接入同一个实时会话。'),
						snapshot.lastError === null ? null : h('div', { className: 'mc-error' }, String(snapshot.lastError))
					)
				)
			}

			const usage = snapshot.usage
			const pending = snapshot.approvals.length + snapshot.questions.length

			return h('div', { className: 'mc-root' },
				h('div', { className: 'mc-head' },
					h('span', { className: 'mc-dot', 'data-status': snapshot.status }),
					h('span', { className: 'mc-head-title' }, 'Muse Code'),
					h('span', { className: 'mc-head-sub' }, `${snapshot.session?.modelId ?? 'muse'} · ${running ? '运行中' : snapshot.status === 'starting' ? '启动中' : '空闲'}`),
					usage === null ? null : h('span', { className: 'mc-usage' }, `${Math.round((usage.usedTokens ?? 0) / 1000)}k / ${usage.windowTokens === null || usage.windowTokens === undefined ? '?' : Math.round(usage.windowTokens / 1000) + 'k'}`),
					pending > 0 ? h('span', { className: 'dsw-mc-badge' }, String(pending)) : null
				),
				h(BudgetBar, { budget }),
				h(SandboxNotice, null),
				h('div', { className: 'mc-scroll', ref: scroller },
					items.length === 0
						? h('div', { className: 'mc-empty' }, '在下面输入任务，Muse Code 会在这个工作区里开始工作；聊天里的工具与这里共享同一个会话。')
						: items.map((item) => h(Item, { key: item.itemId, item })),
					...snapshot.approvals.map((approval) => h(ApprovalCard, { key: approval.approvalId, approval })),
					...snapshot.questions.map((question) => h(QuestionCard, { key: question.userInputId, question }))
				),
				h('div', { className: 'mc-compose' },
					snapshot.lastError === null ? null : h('div', { className: 'mc-error' }, String(snapshot.lastError)),
					error === '' ? null : h('div', { className: 'mc-error' }, error),
					h('textarea', {
						value: draft,
						disabled: locked,
						placeholder: locked
							? '已触发花费上限，Muse Code 已强制停止。提高上限或重置后才能继续。'
							: running ? 'Muse 正在运行：回车把这条消息插进当前回合（steer）' : '交给 Muse Code 的任务，回车发送（Shift+回车换行）',
						onChange: (event) => setDraft(event.target.value),
						onKeyDown: (event) => {
							if (event.key !== 'Enter' || event.shiftKey) return
							event.preventDefault()
							send()
						}
					}),
					h('div', { className: 'mc-compose-row' },
						h('button', { type: 'button', className: 'mc-btn', 'data-variant': 'primary', disabled: sending || draft.trim() === '' || locked, onClick: send }, sending ? '发送中…' : running ? '插入当前回合' : '发送'),
						running ? h('button', { type: 'button', className: 'mc-btn', 'data-variant': 'danger', onClick: () => { post(BASE + '/interrupt', {}).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))) } }, '停止') : null,
						h('span', { className: 'mc-hint' }, `会话 ${String(snapshot.session?.sessionId ?? '').slice(0, 8)}`)
					)
				)
			)
		}

		/**
		 * Open the Muse Code tab, creating it if needed.
		 */
		function openPanel() {
			try {
				const sidebar = ctxRef.get('sidebarRight')
				sidebar?.openTab?.(TAB_KIND, { params: {} })
			} catch (error) {
				console.warn('[dsh-muse-code] openTab failed', error)
			}
		}

		/** Close the Muse Code tab if it is mounted. */
		function closePanel() {
			try {
				const sidebar = ctxRef.get('sidebarRight')
				if (store.tabId !== undefined) sidebar?.close?.(store.tabId)
			} catch (error) {
				console.warn('[dsh-muse-code] close failed', error)
			}
		}

		/** @type {object} the client context captured in `apply`. */
		let ctxRef = undefined

		/**
		 * Inject the stylesheet once.
		 * @returns {() => void} cleanup.
		 */
		function installStyles() {
			if (document.getElementById(STYLE_ID) !== null) return () => {}
			const style = document.createElement('style')
			style.id = STYLE_ID
			style.textContent = CSS
			document.head.appendChild(style)
			return () => { style.remove() }
		}

		/**
		 * Plugin entry point.
		 * @param {object} ctx - client context with `slots`.
		 */
		function apply(ctx) {
			ctxRef = ctx
			ctx.effect(installStyles, 'muse-code styles')

			// The SSE stream is a plugin-owned resource: close it when this
			// client half is disposed (disable, reload, uninstall) so no dead
			// EventSource keeps reconnecting against a torn-down host.
			ctx.effect(() => () => {
				store.source?.close()
				store.source = undefined
			}, 'muse-code sse')

			ctx.slots.inject(SEAT, () => ctx.slots.register({
				name: SEAT,
				id: ENTRY_ID,
				order: -100
			}, Toggle))

			ctx.inject(['sidebarRightTabs'], (injected) => {
				const tabs = injected.get('sidebarRightTabs')
				if (tabs === undefined) return
				ctx.effect(() => tabs.register({
					id: TAB_ID,
					kind: TAB_KIND,
					keepMounted: true,
					priority: 'extension',
					title: () => 'Muse Code'
				}), 'muse-code tab type')
			})

			ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
				name: 'sidebar.right.pane.tab',
				key: TAB_ID,
				inject: (sessionId) => ({ sessionId })
			}, Panel))
		}

		const module = { exports: {} }
		module.exports.apply = apply
		module.exports.inject = ['slots']
		return module.exports
	}
})
