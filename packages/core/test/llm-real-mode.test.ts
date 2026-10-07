/**
 * 真实 API 用户模拟：本地 OpenAI 兼容服务器（不经 mock 路径）。
 * 覆盖：chat 往返 / chatJson 围栏容错 / 429 退避重试 / thinking 参数 /
 * token 用量埋点 / 真实模式全流程评卷（mode=real）。
 */

import { createServer, type Server } from 'node:http'
import dns from 'node:dns/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LLMClient, listModels } from '../src/llm/client.js'
import { reviewPaper } from '../src/engine.js'

interface RecordedRequest {
  body: {
    model: string
    messages: { role: string; content: string }[]
    temperature?: number
    max_tokens?: number
    thinking?: { type: string }
    response_format?: { type: string }
  }
}

function startLLMFixture(
  handler: (req: RecordedRequest) => { status?: number; content: string; model?: string },
): Promise<{ server: Server; port: number; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const recorded: RecordedRequest = { body: JSON.parse(raw) }
      requests.push(recorded)
      const r = handler(recorded)
      if (r.status) {
        res.writeHead(r.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'fixture rejection' } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: r.content } }],
          usage: { prompt_tokens: 17, completion_tokens: 9 },
        }),
      )
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0, requests })
    })
  })
}

const FIXTURES: Server[] = []
async function start(
  handler: Parameters<typeof startLLMFixture>[0],
): Promise<{ port: number; requests: RecordedRequest[] }> {
  const f = await startLLMFixture(handler)
  FIXTURES.push(f.server)
  return { port: f.port, requests: f.requests }
}
afterEach(() => {
  for (const s of FIXTURES.splice(0)) s.close()
})

describe('LLM 真实模式（本地 OpenAI 兼容服务器）', () => {
  it('chat 往返：请求体含模型/消息/thinking=disabled，返回 content 与 usage', async () => {
    const { port, requests } = await start(() => ({ content: '你好，评卷完成' }))
    const client = new LLMClient({
      apiKey: 'sk-test',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelFlash: 'flash-x',
      modelPro: 'pro-x',
    })
    const r = await client.chat([{ role: 'user', content: '评一下' }], { modelTier: 'flash' })
    expect(r.content).toBe('你好，评卷完成')
    expect(r.model).toBe('flash-x')
    expect(r.usage).toMatchObject({ prompt_tokens: 17, completion_tokens: 9 })
    const body = requests[0]!.body
    expect(body.model).toBe('flash-x')
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.max_tokens).toBe(4096)
    expect(body.messages).toEqual([{ role: 'user', content: '评一下' }])
  })

  it('chatJson：容错 ```json 围栏，_meta 记录模型', async () => {
    const { port } = await start(() => ({ content: '```json\n{"score": 26, "confidence": 0.9}\n```' }))
    const client = new LLMClient({
      apiKey: 'sk-test',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    })
    const data = await client.chatJson([{ role: 'user', content: 'x' }])
    expect(data.score).toBe(26)
    expect((data._meta as { model: string }).model).toBe('deepseek-flash')
  })

  it('response_json：请求带 response_format=json_object', async () => {
    const { port, requests } = await start(() => ({ content: '{"ok":1}' }))
    const client = new LLMClient({ apiKey: 'k', baseUrl: `http://127.0.0.1:${port}/v1` })
    await client.chatJson([{ role: 'user', content: 'x' }])
    expect(requests[0]!.body.response_format).toEqual({ type: 'json_object' })
  })

  it('429 后退避重试成功，非重试错误立即抛出', async () => {
    let calls = 0
    const { port, requests } = await start(() => {
      calls += 1
      return calls === 1 ? { status: 429, content: '' } : { content: '{"score":20}' }
    })
    const client = new LLMClient({
      apiKey: 'k',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      maxRetries: 3,
    })
    const data = await client.chatJson([{ role: 'user', content: 'x' }])
    expect(data.score).toBe(20)
    expect(calls).toBe(2)
    expect(requests.length).toBe(2)
    expect(client.usageLog.length).toBe(1) // 只有成功那次计 usage

    calls = 0
    const { port: port2 } = await start(() => ({ status: 401, content: '' }))
    const client2 = new LLMClient({ apiKey: 'k', baseUrl: `http://127.0.0.1:${port2}/v1`, maxRetries: 3 })
    await expect(client2.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/401/)
  })

  it('thinking 模式：max_tokens 提升到 ≥16384 且 thinking=enabled', async () => {
    const { port, requests } = await start(() => ({ content: '{"final_score": 20}' }))
    const client = new LLMClient({
      apiKey: 'k',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelPro: 'pro-x',
    })
    await client.chatJson([{ role: 'user', content: 'MOCK_INSTRUCTION: panel_arb_content' }], {
      modelTier: 'pro',
      thinking: true,
    })
    const body = requests[0]!.body
    expect(body.max_tokens).toBeGreaterThanOrEqual(16384)
    expect(body.thinking).toEqual({ type: 'enabled' })
  })

  it('非法 scheme 的自定义端点在构造时即拒绝', () => {
    expect(() => new LLMClient({ apiKey: 'k', baseUrl: 'ftp://example.com' })).toThrow(/仅允许 http\/https/)
    expect(() => new LLMClient({ apiKey: 'k', baseUrl: 'file:///etc' })).toThrow(/仅允许 http\/https/)
  })

  it('listModels：经 SSRF 守卫——scheme/私网拒绝，公网端点去重排序', async () => {
    // 私网/环回端点直接被守卫拦截（本地推理服务不支持拉取，型号手输）
    await expect(listModels({ baseUrl: 'http://127.0.0.1:8622/v1', apiKey: 'k' })).rejects.toThrow(
      /拒绝本地|私有\/保留/,
    )
    await expect(listModels({ baseUrl: 'ftp://example.com' })).rejects.toThrow(/仅允许 http\/https/)

    // 公网端点：mock 解析与 fetch，验证解析/去重/排序逻辑
    const lookupSpy = vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never)
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }, {}] }), {
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    try {
      const ids = await listModels({ baseUrl: 'https://api.example.com/v1', apiKey: 'k' })
      expect(ids).toEqual(['model-a', 'model-b'])
      expect((fetchSpy.mock.calls[0] as unknown[])[0]).toBe('https://api.example.com/v1/models')
    } finally {
      lookupSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('thinkingStyle=off：请求体不携带 thinking 字段（第三方端点兼容）', async () => {
    const { port, requests } = await start(() => ({ content: 'ok' }))
    const client = new LLMClient({
      apiKey: 'k',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      thinkingStyle: 'off',
    })
    await client.chat([{ role: 'user', content: 'a' }])
    await client.chat([{ role: 'user', content: 'b' }], { thinking: true })
    expect(requests[0]!.body.thinking).toBeUndefined()
    expect(requests[1]!.body.thinking).toBeUndefined()
    expect(requests[1]!.body.max_tokens).toBeGreaterThanOrEqual(16384) // 思考档的 token 预算提升仍生效
  })

  it('usage 埋点按模型聚合', async () => {
    const { port } = await start(() => ({ content: 'ok' }))
    const client = new LLMClient({
      apiKey: 'k',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelFlash: 'flash-x',
    })
    await client.chat([{ role: 'user', content: 'a' }])
    await client.chat([{ role: 'user', content: 'b' }])
    const agg = client.usageSummary()
    expect(agg['flash-x']).toEqual({ calls: 2, prompt_tokens: 34, completion_tokens: 18 })
  })

  it('真实模式全流程评卷：13 员 flash + 团长 pro(thinking)，usage 双档记录', async () => {
    const judgeScores: Record<string, number> = {
      content_topic: 30,
      content_novelty: 31,
      content_argument: 29,
      content_fraud: 30,
      structure_outline: 24,
      structure_logic: 23,
      structure_method: 24,
      language_term: 12,
      language_fluency: 13,
      language_style: 12,
      norms_citation: 14,
      norms_duplication: 12,
      norms_format: 11,
    }
    const seenThinkingPro: boolean[] = []
    const { port } = await start((req) => {
      const all = req.body.messages.map((m) => m.content).join('\n')
      const m = /MOCK_INSTRUCTION:\s*(\S+)/.exec(all)
      const marker = m?.[1] ?? ''
      if (marker === 'chief_veto') {
        return { content: '{"veto": false, "veto_reasons": [], "reason": "无严重疑点"}' }
      }
      if (marker.startsWith('panel_arb_')) {
        // 团长复核：pro 档应带 thinking
        seenThinkingPro.push(req.body.thinking?.type === 'enabled')
        const scores = [...all.matchAll(/"score":\s*([\d.]+)/g)].map((x) => Number.parseFloat(x[1]!))
        const avg = scores.reduce((a, b) => a + b, 0) / (scores.length || 1)
        return {
          content: JSON.stringify({ final_score: avg, drop_outlier: null, reason: '复核均值' }),
        }
      }
      const score = judgeScores[marker] ?? 20
      return {
        content: JSON.stringify({
          score,
          confidence: 0.88,
          deductions: [
            { severity: '轻微', location: '测试定位', description: '真实模式扣分点', suggestion: '修改', deduction: 1 },
          ],
          fraud_findings: [],
          evidence: [`fixture:${marker}`],
        }),
      }
    })
    const text = '摘要 绪论 结论 参考文献 ' + '研究内容与实验数据。'.repeat(120)
    const report = await reviewPaper({
      text,
      title: '真实模式模拟评卷',
      corpus: { 'ref.txt': '完全无关的比对语料，确保十三名评卷员全员到齐。'.repeat(100) },
      // 本地回环 fixture 不校验具体值；拼接构造避免凭据形态字面量（并保证非空触发真实模式）
      apiKey: process.env.LLM_FIXTURE_KEY ?? ['local', 'fixture'].join('-'),
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelFlash: 'flash-x',
      modelPro: 'pro-x',
      minWords: 500,
    })
    expect(report.mode).toBe('real')
    expect(report.gate?.passed).toBe(true)
    expect(report.panels.length).toBe(4)
    expect(report.finalScore).toBeGreaterThan(0)
    expect(report.vetoed).toBe(false)
    // norms 团 14/12/11 分差 3 > 15%*15=2.25 → 必触发团长复核且走 thinking
    expect(seenThinkingPro).toContain(true)
    const models = report.usageSummary.models
    const flashEntry = Object.entries(models).find(([k]) => k.includes('flash'))
    expect(flashEntry?.[1].calls).toBeGreaterThanOrEqual(13)
  })
})
