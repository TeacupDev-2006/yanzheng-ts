/** LLM 客户端与引擎默认 mock 流水线测试（对照原 tests/test_core.py TestClient）。 */

import { describe, expect, it } from 'vitest'
import { LLMClient } from '../src/llm/client.js'
import { reviewPaper } from '../src/engine.js'

describe('llm client', () => {
  it('mock_fn JSON 往返', async () => {
    const c = new LLMClient({
      mock: true,
      mockFn: () => '{"score": 30, "confidence": 0.9}',
    })
    const data = await c.chatJson([{ role: 'user', content: 'x' }])
    expect(data.score).toBe(30)
  })

  it('mock_fn 带 ```json 围栏可解析', async () => {
    const c = new LLMClient({ mock: true, mockFn: () => '```json\n{"score": 25}\n```' })
    const data = await c.chatJson([{ role: 'user', content: 'x' }])
    expect(data.score).toBe(25)
  })

  it('无 key 即 mock 模式', () => {
    const c = new LLMClient({ apiKey: null })
    expect(c.mock).toBe(true)
  })

  it('默认 mock 返回合法 JSON（守护测试：CLI 无 mock_fn 依赖此路径）', async () => {
    const c = new LLMClient({ mock: true })
    const data = await c.chatJson([{ role: 'user', content: 'MOCK_INSTRUCTION: content_topic' }])
    expect(data.score).toBe(24.0)
    expect(Array.isArray(data.deductions)).toBe(true)
    expect((data.deductions as unknown[]).length).toBeGreaterThan(0)
    const arb = await c.chatJson([{ role: 'user', content: 'MOCK_INSTRUCTION: panel_arb_content' }])
    expect('final_score' in arb).toBe(true)
    const veto = await c.chatJson([{ role: 'user', content: 'MOCK_INSTRUCTION: chief_veto' }])
    expect('veto' in veto).toBe(true)
  })

  it('引擎默认 mock 端到端（无 key 无 mock_fn 的 CLI mock 模式底层路径）', async () => {
    const report = await reviewPaper({
      text: '摘要 绪论 总结 参考文献 ' + '正文内容。'.repeat(300),
      title: '默认mock流水线测试',
      minWords: 500,
    })
    expect(report.gate?.passed).toBe(true)
    expect(report.panels.length).toBe(4)
    expect(report.finalScore).toBeGreaterThan(0)
  })
})
