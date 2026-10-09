/**
 * 双页结构 + 配置持久化测试：
 * - `/` 投稿页轻量化（配置摘要 + 临时 Key + 跳转链接，无编辑器）
 * - `/config` 专职配置页（编制编辑器 + 12 厂商预设 + 保存）
 * - `/api/config` 保存/重置、apiKey 保留语义、scheme 校验
 * - 保存后投稿页与 /review 即时生效
 *
 * 数据目录经 YANZHENG_DATA_DIR 隔离到临时目录，不污染真实运行配置。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'

const DATA = fileURLToPath(new URL('../../../testdata/', import.meta.url))
const PAPER = readFileSync(DATA + 'demo_paper.txt', 'utf-8')

const servers: ReturnType<typeof serve>[] = []
let dataDir = ''

beforeAll(async () => {
  delete process.env.DEEPSEEK_API_KEY
  dataDir = await mkdtemp(join(tmpdir(), 'yanzheng-cfg-'))
  process.env.YANZHENG_DATA_DIR = dataDir
})
afterAll(async () => {
  delete process.env.YANZHENG_DATA_DIR
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  for (const s of servers.splice(0)) {
    await new Promise<void>((done) => s.close(() => done()))
  }
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

describe('双页结构', () => {
  it('投稿页轻量化：配置摘要 + 临时 Key + 跳转，无编辑器', async () => {
    const base = await startServer()
    const html = await (await fetch(base + '/')).text()
    expect(html).toContain('当前生效编制')
    expect(html).toContain('修改 →') || expect(html).toContain('修改')
    expect(html).toContain('/config')
    expect(html).toContain('name="llm_key"')
    expect(html).toContain('本次评卷优先使用')
    expect(html).toContain('name="min_words"')
    // 编辑器不在投稿页
    expect(html).not.toContain('id="add-panel"')
    expect(html).not.toContain('name="rubric_json"')
    // 默认编制摘要：4 团 13 员 总分 100
    expect(html).toContain('4 团 13 员 · 总分 100')
    expect(html).toContain('DeepSeek')
  })

  it('配置页专职：编辑器 + 国内厂商预设 + 已存值回填', async () => {
    const base = await startServer()
    const html = await (await fetch(base + '/config')).text()
    expect(html).toContain('id="add-panel"')
    expect(html).toContain('id="reset-rubric"')
    expect(html).toContain('id="save"')
    expect(html).toContain('id="pull-models"')
    expect(html).toContain('skills-data')
    expect(html).toContain('data_consistency')
    for (const vendor of ['DeepSeek', 'Kimi', 'Qwen 通义千问', 'GLM', '豆包', '文心一言', '混元', '星火', 'MiniMax', '自定义']) {
      expect(html).toContain(vendor)
    }
    // 国外厂商预设已移除
    for (const foreign of ['OpenAI（GPT', 'Anthropic', 'Google Gemini', 'xAI', 'OpenRouter', 'Agnes 赛事端点']) {
      expect(html).not.toContain(foreign)
    }
    // 已保存的编制与 LLM 设置回填（默认：deepseek 4 团）
    const panels = JSON.parse(/id="panels-data" type="application\/json">(.+?)<\/script>/s.exec(html)![1]!) as unknown[]
    expect(panels.length).toBe(4)
    const llm = JSON.parse(/id="llm-data" type="application\/json">(.+?)<\/script>/s.exec(html)![1]!) as { preset: string; modelJudge: string }
    expect(llm.preset).toBe('deepseek')
    expect(llm.modelJudge).toBe('deepseek-flash')
    // 返回投稿页链接
    expect(html).toContain('href="/">')
  })
})

describe('配置保存与生效链路', () => {
  it('保存自定义编制 → 投稿页摘要更新 → /review 用新编制评卷', async () => {
    const base = await startServer()
    const rubric = [
      {
        name: '国际评审团',
        maxScore: 40,
        judges: [
          { name: 'GPT审稿人', skills: [], modelTier: 'flash' },
          { name: 'Claude审稿人', skills: ['data_consistency'], modelTier: 'pro' },
        ],
      },
    ]
    const save = await fetch(base + '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm: { keep: true }, panels: rubric }),
    })
    expect(save.status).toBe(200)
    expect(await save.json()).toMatchObject({ ok: true, panels: 1, judges: 2 })

    // 投稿页摘要即时更新
    const home = await (await fetch(base + '/')).text()
    expect(home).toContain('1 团 2 员 · 总分 40')
    expect(home).toContain('国际评审团')

    // /review 用新编制（无 key → 演示 mock）
    const fd = new FormData()
    fd.set('file', new File([PAPER], 'demo_paper.txt'))
    fd.set('min_words', '1000')
    const review = await fetch(base + '/review', { method: 'POST', body: fd })
    expect(review.status).toBe(200)
    const html = await review.text()
    expect(html).toContain('国际评审团')
    expect(html).toContain('GPT审稿人')
    expect(html).not.toContain('规范核查团')
  })

  it('apiKey 语义：保存 key → 再次保存不带 apiKey 字段 → key 保留；带 null → 清除', async () => {
    const base = await startServer()
    const cfgFile = join(dataDir, 'rubric.json')

    // 1) 保存带 key
    await fetch(base + '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        llm: { preset: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelJudge: 'qwen-flash', modelArbiter: 'qwen3-max', thinkingStyle: 'off', apiKey: 'test-key-123' },
        panels: null,
      }),
    })
    let stored = JSON.parse(await readFile(cfgFile, 'utf-8')) as { llm: { apiKey: string | null; modelJudge: string } }
    expect(stored.llm.apiKey).toBe('test-key-123')

    // 2) 再次保存只改编制、不带 apiKey 字段 → key 保留
    await fetch(base + '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm: { keep: true }, panels: [{ name: 'X团', maxScore: 30, judges: [{ name: 'x' }] }] }),
    })
    stored = JSON.parse(await readFile(cfgFile, 'utf-8'))
    expect(stored.llm.apiKey).toBe('test-key-123')
    expect(stored.llm.modelJudge).toBe('qwen-flash')

    // 3) 带 apiKey:null → 显式清除（回演示模式）
    await fetch(base + '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm: { keep: true, apiKey: null }, panels: null }),
    })
    stored = JSON.parse(await readFile(cfgFile, 'utf-8'))
    expect(stored.llm.apiKey).toBeNull()

    // 4) 配置页回填：已存 key 显示为占位提示（不回写明文）
    const html = await (await fetch(base + '/config')).text()
    expect(html).not.toContain('test-key-123')
  })

  it('非法配置被拒：坏 JSON 结构 / 满分非正 / scheme 违规', async () => {
    const base = await startServer()
    const r1 = await fetch(base + '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ panels: [{ name: 'X', maxScore: 0, judges: [{ name: 'a' }] }] }),
    })
    expect(r1.status).toBe(400)
    expect((await r1.json()).error).toContain('满分必须为正数')

    const r2 = await fetch(base + '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm: { baseUrl: 'ftp://x.com' }, panels: null }),
    })
    expect(r2.status).toBe(400)
    expect((await r2.json()).error).toContain('仅允许 http/https')
  })

  it('panels:null 恢复默认 4 团 13 员', async () => {
    const base = await startServer()
    await fetch(base + '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm: { keep: true }, panels: null }),
    })
    const home = await (await fetch(base + '/')).text()
    expect(home).toContain('4 团 13 员 · 总分 100')
  })
})

describe('具体模型选择（/llm/models 代理 + 配置页目录）', () => {
  it('配置页含拉取按钮、两档 datalist 与国内厂商型号目录', async () => {
    const base = await startServer()
    const html = await (await fetch(base + '/config')).text()
    expect(html).toContain('id="pull-models"')
    expect(html).toContain('list="model_judge_list"')
    expect(html).toContain('list="model_arbiter_list"')
    // 国内厂商官方兼容端点与代表型号
    for (const marker of [
      'https://api.deepseek.com',
      'https://api.moonshot.cn/v1',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'https://open.bigmodel.cn/api/paas/v4',
      'https://ark.cn-beijing.volces.com/api/v3',
      'https://qianfan.baidubce.com/v2',
      'https://api.hunyuan.cloud.tencent.com/v1',
      'https://spark-api-open.xf-yun.com/v1',
      'https://api.minimaxi.com/v1',
      "'deepseek-flash'",
      'kimi-k2-thinking',
      'qwen3-max',
      'glm-4.6',
      'doubao-1-5-thinking-pro-m-250428',
      'ernie-4.5-turbo-128k',
      'hunyuan-turbos-20250416',
      '4.0Ultra',
      'MiniMax-M2',
    ]) {
      expect(html).toContain(marker)
    }
    // 国外型号目录已移除
    for (const foreign of ['gpt-5', 'claude-opus', 'gemini-2.5', 'grok-4', 'openrouter.ai']) {
      expect(html).not.toContain(foreign)
    }
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

    const reserved = await fetch(base + '/llm/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://203.0.113.1/v1' }),
    })
    expect(reserved.status).toBe(502)
    expect((await reserved.json()).error).toContain('私有/保留')
  })
})
