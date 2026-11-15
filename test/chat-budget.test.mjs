// 輸出上限：預設 8192、CHAT_MAX_TOKENS／CAP、推理用光額度時自動放大重試（HTTP 錯誤與串流中途錯誤兩種）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { chatMaxTokens, chatMaxTokensCap, handleChat, isOutputBudgetError } from '../src/chat.js'

const provider = { baseUrl: 'https://api.example.com/openai/v1', apiKey: 'k', model: 'openai/gpt-oss-120b' }
const sseBody = (chunks) => chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('')
const streamRes = (text) => new Response(text, { headers: { 'content-type': 'text/event-stream' } })
const BUDGET = 'The model used its entire output budget on reasoning and returned no answer. Raise max_tokens or simplify the request, then try again.'

async function run(env, responders) {
  const orig = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); sent.push(b); return responders[sent.length - 1](b) }
  try {
    const req = new Request('https://x/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'hi', use_tools: false }) })
    const res = await handleChat(req, env, { resolveProvider: async () => provider })
    return { res, text: await res.text(), sent }
  } finally { globalThis.fetch = orig }
}

test('max_tokens defaults and caps', () => {
  assert.equal(chatMaxTokens({}, {}), 8192)
  assert.equal(chatMaxTokens({}, { CHAT_MAX_TOKENS: '16000' }), 16000)
  assert.equal(chatMaxTokens({ max_tokens: 999999 }, {}), 32768)
  assert.equal(chatMaxTokensCap({ CHAT_MAX_TOKENS_CAP: '65536' }), 65536)
  assert.ok(isOutputBudgetError(BUDGET))
  assert.ok(!isOutputBudgetError('Invalid API key'))
})

test('HTTP budget error -> retries once with 4x max_tokens', async () => {
  const { res, text, sent } = await run({}, [
    () => new Response(JSON.stringify({ error: { message: BUDGET } }), { status: 400, headers: { 'content-type': 'application/json' } }),
    () => streamRes(sseBody([{ choices: [{ delta: { content: '答案' } }] }, '[DONE]'])),
  ])
  assert.equal(res.status, 200)
  assert.equal(sent[0].max_tokens, 8192)
  assert.equal(sent[1].max_tokens, 32768)
  assert.match(text, /答案/)
})

test('in-stream budget error before content -> transparent retry', async () => {
  const { text, sent } = await run({ CHAT_REASONING_EFFORT: 'low' }, [
    () => streamRes(sseBody([{ choices: [{ delta: { reasoning: '想…' } }] }, { error: { message: BUDGET } }, '[DONE]'])),
    () => streamRes(sseBody([{ choices: [{ delta: { content: '第二次成功' } }] }, '[DONE]'])),
  ])
  assert.equal(sent.length, 2)
  assert.equal(sent[0].reasoning_effort, 'low')
  assert.match(text, /第二次成功/)
  assert.doesNotMatch(text, /output budget/)
})

test('empty finish_reason=length -> retry; second failure gives Chinese error', async () => {
  const empty = () => streamRes(sseBody([{ choices: [{ delta: {}, finish_reason: 'length' }] }, '[DONE]']))
  const { text, sent } = await run({ CHAT_MAX_TOKENS_CAP: '16384' }, [empty, empty])
  assert.equal(sent.length, 2)
  assert.equal(sent[1].max_tokens, 16384)
  assert.match(text, /都用在推理/)
})

test('content already sent -> no retry', async () => {
  const { text, sent } = await run({}, [
    () => streamRes(sseBody([{ choices: [{ delta: { content: '部分' } }] }, { choices: [{ delta: {}, finish_reason: 'length' }] }, '[DONE]'])),
  ])
  assert.equal(sent.length, 1)
  assert.match(text, /部分/)
})
