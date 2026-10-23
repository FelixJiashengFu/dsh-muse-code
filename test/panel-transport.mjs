/**
 * End-to-end check of the panel's own transport.
 *
 * Talks to the running DSH host exactly like the browser panel does:
 *   GET  /plugins/dsh-muse-code/state   (plain GET, no custom header)
 *   GET  /plugins/dsh-muse-code/events  (EventSource-style stream, no header)
 *   POST /plugins/dsh-muse-code/prompt  (loopback + origin + x-muse-code)
 *
 * then waits for the turn to finish and prints the assistant text it saw on
 * both channels. Fails when the SSE stream stays silent or the transcript
 * does not grow.
 *
 * It spends real Muse tokens, so run it only when accepting a release.
 *
 * Run: node test/panel-transport.mjs [origin]
 *   origin defaults to $DSH_ORIGIN, then to the URL printed by `dsh web`
 *   (`http://127.0.0.1:54716` while the desktop app is running).
 */
const ORIGIN = (process.argv[2] ?? process.env.DSH_ORIGIN ?? 'http://127.0.0.1:54716').replace(/\/+$/, '')
const BASE = `${ORIGIN}/plugins/dsh-muse-code`
const POST_HEADERS = { 'content-type': 'application/json', 'x-muse-code': '1', origin: ORIGIN }
const PROMPT = '只回复四个字：面板通道就绪'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const failures = []
const check = (name, ok, detail) => {
	if (ok) console.log(`PASS  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
	else {
		failures.push(name)
		console.log(`FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
	}
}

// 1. state, as the panel polls it
const stateResponse = await fetch(`${BASE}/state`, { cache: 'no-store' })
check('state-200', stateResponse.status === 200, `status ${stateResponse.status}`)
const stateBody = await stateResponse.json()
const snapshot = stateBody.snapshot
check('state-shape', stateBody.ok === true && snapshot !== undefined, `enabled=${snapshot?.enabled} status=${snapshot?.status}`)
check('state-session', typeof snapshot?.session?.sessionId === 'string', snapshot?.session?.sessionId)
const sessionId = snapshot?.session?.sessionId
const before = Array.isArray(snapshot?.items) ? snapshot.items.length : 0

// 2. the SSE stream, opened exactly like `new EventSource(...)` does
const stream = await fetch(`${BASE}/events`, { headers: { accept: 'text/event-stream' } })
check('events-200', stream.status === 200, `content-type ${stream.headers.get('content-type')}`)
const reader = stream.body.getReader()
const decoder = new TextDecoder()
const events = []
let buffer = ''
let reading = true
const pump = (async () => {
	while (reading) {
		const { value, done } = await reader.read()
		if (done) break
		buffer += decoder.decode(value, { stream: true })
		let cut
		while ((cut = buffer.indexOf('\n\n')) >= 0) {
			const frame = buffer.slice(0, cut)
			buffer = buffer.slice(cut + 2)
			for (const line of frame.split('\n')) {
				if (!line.startsWith('data: ')) continue
				try {
					events.push(JSON.parse(line.slice(6)))
				} catch {
					// ignore keep-alive noise
				}
			}
		}
	}
})()

await sleep(500)
check('events-snapshot-frame', events.some((event) => event.type === 'snapshot'), `${events.length} frame(s)`)

// 3. prompt through the panel's route
const promptResponse = await fetch(`${BASE}/prompt`, {
	method: 'POST',
	headers: POST_HEADERS,
	body: JSON.stringify({ text: PROMPT, sessionId })
})
const promptBody = await promptResponse.json()
check('prompt-200', promptResponse.status === 200 && promptBody.ok === true, `disposition=${promptBody?.ack?.disposition}`)

// 4. wait for the turn to finish, watching both channels
const deadline = Date.now() + 180_000
let sawTurnCompleted = false
let sawStreaming = false
let finalState
while (Date.now() < deadline) {
	await sleep(1500)
	sawTurnCompleted = sawTurnCompleted || events.some((event) => event.type === 'turn' && event.turn?.terminal !== undefined)
	sawStreaming = sawStreaming || events.some((event) => event.type === 'delta')
	const response = await fetch(`${BASE}/state`, { cache: 'no-store' })
	const body = await response.json()
	if (body.snapshot?.status === 'idle' && (body.snapshot?.items?.length ?? 0) > before) {
		finalState = body.snapshot
		break
	}
}

check('sse-turn-completed', sawTurnCompleted, `saw ${events.filter((e) => e.type === 'turn').length} turn frame(s)`)
check('sse-streaming', sawStreaming, `saw ${events.filter((e) => e.type === 'delta').length} delta frame(s)`)
check('turn-finished', finalState !== undefined, finalState === undefined ? 'timeout' : `status ${finalState.status}`)

if (finalState !== undefined) {
	const answers = finalState.items.filter((item) => item.kind === 'agentMessage' && typeof item.text === 'string' && item.text !== '')
	const answer = answers[answers.length - 1]
	check('assistant-text', answer !== undefined && answer.text.includes('就绪'), answer === undefined ? 'no agentMessage' : answer.text.trim())
	console.log(`\nMuse said: ${answer?.text?.trim() ?? '(nothing)'}`)
	console.log(`session: ${finalState.session?.sessionId}  workspace: ${finalState.session?.workspaceRoot}`)
	console.log(`events: ${events.length}  kinds: ${[...new Set(events.map((e) => e.type))].join(', ')}`)
}

reading = false
await Promise.race([pump, sleep(1000)])
try { await reader.cancel() } catch { /* closed */ }

if (failures.length > 0) {
	console.log(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
	process.exitCode = 1
} else {
	console.log('\nall panel transport checks passed')
}
