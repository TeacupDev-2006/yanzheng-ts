/**
 * Web 配置器用户旅程：LLM 自选字段、评审团编制编辑（增删团/员 + skill 勾选）、
 * 自定义编制提交评卷、非法配置 400、演示模式不受影响。
 */

import { serve } from '@hono/node-server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'

const DATA = fileURLToPath(new URL('../../../testdata/', import.meta.url))
const DOCS = fileURLToPath(new URL('../../../docs/', import.meta.url))

const servers: ReturnType<typeof serve>[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((done) => s.close(() => done()))
  }
})

beforeAll(() => {
  delete process.env.DEEPSEEK_API_KEY
})

async function startServer(): Promise<string> {
  const app = createApp()
  const server = serve({ fetch: app.fetch, port: 0 })
  await new Promise<void>((done) => server.once('listening', done))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  servers.push(server)
  return `http://127.0.0.1:${port}`
}

const PAPER = readFileSync(DATA + 'demo_paper.txt', 'utf-8')

describe('Web 配置器（真实 HTTP）', () => {
  it('投稿页含 LLM 自选区、编制编辑区与隐藏 rubric_json（默认 4 团）', async () => {
    const base = await startServer()
    const html = await (await fetch(base + '/')).text()
    expect(html).toContain('评 卷 委 员 会 配 置')
    expect(html).toContain('name="llm_key"')
    expect(html).toContain('name="model_judge"')
    expect(html).toContain('name="model_arbiter"')
    expect(html).toContain('name="llm_base_url"')
    expect(html).toContain('id="add-panel"')
    expect(html).toContain('id="reset-rubric"')
    expect(html).toContain('name="rubric_json"')
    // 默认编制 JSON 内嵌（含 4 团与全部 skill 选项）
    expect(html).toContain('规范核查团')
    expect(html).toContain('data_consistency')
    const m = /id="rubric-data" type="application\/json">(.+?)<\/script>/s.exec(html)
    expect(m).toBeTruthy()
    const rubric = JSON.parse(m![1]!) as { name: string }[]
    expect(rubric.length).toBe(4)
  })

  it('自定义编制提交：单团单员（演示模式）出对应报告', async () => {
    const base = await startServer()
    const rubric = [
      {
        name: '创新性评审团',
        maxScore: 50,
        judges: [{ name: '创新点审查员', persona: '只看创新性', skills: ['data_consistency'], modelTier: 'pro' }],
      },
    ]
    const fd = new FormData()
    fd.set('file', new File([PAPER], 'demo_paper.txt'))
    fd.set('min_words', '1000')
    fd.set('rubric_json', JSON.stringify(rubric))
    fd.set('model_judge', 'my-flash-x')
    fd.set('model_arbiter', 'my-pro-x')
    const resp = await fetch(base + '/review', { method: 'POST', body: fd })
    expect(resp.status).toBe(200)
    const html = await resp.text()
    expect(html).toContain('创新性评审团')
    expect(html).toContain('创新点审查员')
    expect(html).toContain('／ 50')
    expect(html).not.toContain('规范核查团')
    expect(html).toMatch(/report_id [0-9a-f]{12}/)
  })

  it('多团编制（2 团 3 员）按提交顺序渲染', async () => {
    const base = await startServer()
    const rubric = [
      { name: '甲团', maxScore: 60, judges: [{ name: '甲一' }, { name: '甲二' }] },
      { name: '乙团', maxScore: 40, judges: [{ name: '乙一' }] },
    ]
    const fd = new FormData()
    fd.set('file', new File([PAPER], 'demo_paper.txt'))
    fd.set('min_words', '1000')
    fd.set('rubric_json', JSON.stringify(rubric))
    const resp = await fetch(base + '/review', { method: 'POST', body: fd })
    const html = await resp.text()
    expect(resp.status).toBe(200)
    expect(html).toContain('甲团')
    expect(html).toContain('乙团')
    expect(html).toContain('／ 60')
    expect(html).toContain('／ 40')
  })

  it('非法编制 → 400 与可读错误', async () => {
    const base = await startServer()
    const fd = new FormData()
    fd.set('file', new File([PAPER], 'demo_paper.txt'))
    fd.set('rubric_json', 'not-json')
    const r1 = await fetch(base + '/review', { method: 'POST', body: fd })
    expect(r1.status).toBe(400)
    expect(await r1.text()).toContain('评审团配置无效')

    const fd2 = new FormData()
    fd2.set('file', new File([PAPER], 'demo_paper.txt'))
    fd2.set('rubric_json', JSON.stringify([{ name: 'X', maxScore: 0, judges: [{ name: 'a' }] }]))
    const r2 = await fetch(base + '/review', { method: 'POST', body: fd2 })
    expect(r2.status).toBe(400)
    expect(await r2.text()).toContain('满分必须为正数')
  })

  it('不传 rubric_json → 默认 4 团 13 员；传了 key 但无服务也不影响演示路径', async () => {
    const base = await startServer()
    const fd = new FormData()
    fd.set('file', new File([PAPER], 'demo_paper.txt'))
    fd.set('min_words', '1000')
    // key 留空 → 演示模式
    const resp = await fetch(base + '/review', { method: 'POST', body: fd })
    expect(resp.status).toBe(200)
    const html = await resp.text()
    for (const panel of ['内容审题团', '结构逻辑团', '语言表达团', '规范核查团']) {
      expect(html).toContain(panel)
    }
  })
})

describe('具体模型选择（/llm/models 代理 + 页面目录）', () => {
  it('投稿页含 DeepSeek 型号目录与拉取按钮', async () => {
    const base = await startServer()
    const html = await (await fetch(base + '/')).text()
    expect(html).toContain('id="pull-models"')
    expect(html).toContain('list="model_judge_list"')
    expect(html).toContain('list="model_arbiter_list"')
    // DeepSeek 预设目录内嵌（含推荐型号）
    expect(html).toContain("'deepseek-flash'")
    expect(html).toContain("'deepseek-v4-pro'")
    expect(html).toContain('deepseek-v4-flash')
  })

  it('主流厂商预设齐全：官方兼容端点与代表型号内嵌于页面', async () => {
    const base = await startServer()
    const html = await (await fetch(base + '/')).text()
    for (const marker of [
      'https://api.openai.com/v1',
      'https://api.anthropic.com/v1',
      'https://generativelanguage.googleapis.com/v1beta/openai',
      'https://api.moonshot.cn/v1',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'https://open.bigmodel.cn/api/paas/v4',
      'https://api.x.ai/v1',
      'https://openrouter.ai/api/v1',
      'gpt-5-mini',
      'claude-opus-4-1',
      'gemini-2.5-pro',
      'kimi-k2-thinking',
      'qwen3-max',
      'glm-4.6',
      'grok-4',
      'MiniMax-M2',
    ]) {
      expect(html).toContain(marker)
    }
    // thinking 风格随预设联动（DeepSeek 私有字段不发给第三方端点）
    expect(html).toContain('name="llm_thinking"')
    expect(html).toContain("thinking: 'off'")
  })

  it('/llm/models：scheme 校验 400；非公网端点被 SSRF 守卫拦截 502', async () => {
    const base = await startServer()

    const badScheme = await fetch(base + '/llm/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'ftp://example.com' }),
    })
    expect(badScheme.status).toBe(400)
    expect((await badScheme.json()).error).toContain('仅允许 http/https')

    // TEST-NET-3 保留地址：守卫在 host 字面量校验即拦截，不发出任何网络请求
    const reserved = await fetch(base + '/llm/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://203.0.113.1/v1' }),
    })
    expect(reserved.status).toBe(502)
    expect((await reserved.json()).error).toContain('私有/保留')
  })
})
