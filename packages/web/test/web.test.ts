/**
 * Web 用户操作模拟：真实 HTTP 服务器（@hono/node-server 临时端口）上的
 * 浏览器行为——打开投稿页、健康检查、上传 .txt/.md/.pdf 评卷、
 * 错误操作（错误格式/缺字段/超限体积）。
 */

import { serve } from '@hono/node-server'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp, MAX_UPLOAD } from '../src/app.js'
import { buildPdfTextFixture } from './pdf-fixture.js'

async function startServer(): Promise<string> {
  const app = createApp()
  const server = serve({ fetch: app.fetch, port: 0 })
  await new Promise<void>((done) => server.once('listening', done))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  servers.push(server)
  return `http://127.0.0.1:${port}`
}

const servers: ReturnType<typeof serve>[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((done) => s.close(() => done()))
  }
})

beforeAll(() => {
  delete process.env.DEEPSEEK_API_KEY // 统一为演示模式视角
})

describe('Web 用户旅程（真实 HTTP）', () => {
  it('打开投稿页：期刊风页面 + 演示模式徽标 + 表单字段齐全', async () => {
    const base = await startServer()
    const resp = await fetch(base + '/')
    expect(resp.status).toBe(200)
    const html = await resp.text()
    expect(html).toContain('研')
    expect(html).toContain('演示模式 · 未配置审稿人')
    expect(html).toContain('enctype="multipart/form-data"')
    expect(html).toContain('name="min_words"')
    expect(html).toContain('name="online"')
    expect(html).toContain('accept=".pdf,.txt,.md"')
  })

  it('健康检查', async () => {
    const base = await startServer()
    const resp = await fetch(base + '/health')
    expect(resp.status).toBe(200)
    expect(await resp.json()).toMatchObject({ status: 'ok', mode: 'demo', runtime: 'typescript/agh-native' })
  })

  it('上传 .txt 评卷：返回含 report_id 与总分章的单文件 HTML 报告', async () => {
    const base = await startServer()
    const text = '摘要 绪论 结论 参考文献 ' + '研究内容与实验数据充分。'.repeat(60)
    const fd = new FormData()
    fd.set('file', new File([text], '毕业论文.txt', { type: 'text/plain' }))
    fd.set('min_words', '200')
    const resp = await fetch(base + '/review', { method: 'POST', body: fd })
    expect(resp.status).toBe(200)
    const html = await resp.text()
    expect(html).toContain('研证 · 评卷纪要')
    expect(html).toMatch(/report_id [0-9a-f]{12}/)
    expect(html).toContain('修改优先级路线图')
    expect(html).toContain('评卷过程回放')
  })

  it('上传 .md 评卷同样可用', async () => {
    const base = await startServer()
    const md = '# 论文题目\n\n## 摘要\n\n' + '正文论述。'.repeat(80) + '\n\n## 绪论\n内容\n## 结论\n内容\n## 参考文献\n[1] 某作者. 某文献[J]. 2024.'
    const fd = new FormData()
    fd.set('file', new File([md], 'thesis.md', { type: 'text/markdown' }))
    fd.set('min_words', '100')
    const resp = await fetch(base + '/review', { method: 'POST', body: fd })
    expect(resp.status).toBe(200)
    expect(await resp.text()).toContain('研证 · 评卷纪要')
  })

  it('上传 .pdf：英文文本抽取成功，但按中文论文规范因缺必备章节打回', async () => {
    const base = await startServer()
    const pdf = buildPdfTextFixture(
      'Abstract Introduction Conclusion References ' + 'Research progress and quality analysis '.repeat(30),
    )
    const fd = new FormData()
    fd.set('file', new File([pdf], 'thesis.pdf', { type: 'application/pdf' }))
    fd.set('min_words', '100')
    const resp = await fetch(base + '/review', { method: 'POST', body: fd })
    expect(resp.status).toBe(200)
    const html = await resp.text()
    expect(html).toContain('研证 · 评卷纪要')
    // 抽取成功：打回页应带真实字数（154 = 4 个英文节名 + 5 词 × 30 次重复），而非扫描件提示
    expect(html).toContain('字数：<b>154</b>')
    expect(html).toContain('缺少必备章节：绪论/引言/研究背景') // 英文 Introduction 不在中文别名表
    expect(html).toContain('打回')
  })

  it('上传扫描件样式的近空 PDF：门检打回并提示 OCR', async () => {
    const base = await startServer()
    const pdf = buildPdfTextFixture('a')
    const fd = new FormData()
    fd.set('file', new File([pdf], 'scan.pdf', { type: 'application/pdf' }))
    const resp = await fetch(base + '/review', { method: 'POST', body: fd })
    expect(resp.status).toBe(200)
    const html = await resp.text()
    expect(html).toContain('未通过硬性门检')
    expect(html).toContain('疑似扫描件')
  })

  it('错误操作：不支持的格式被 400 拒绝', async () => {
    const base = await startServer()
    const fd = new FormData()
    fd.set('file', new File(['x'], 'thesis.docx'))
    const resp = await fetch(base + '/review', { method: 'POST', body: fd })
    expect(resp.status).toBe(400)
    expect(await resp.text()).toContain('仅支持')
  })

  it('错误操作：缺少文件字段被 400 拒绝', async () => {
    const base = await startServer()
    const fd = new FormData()
    fd.set('min_words', '100')
    const resp = await fetch(base + '/review', { method: 'POST', body: fd })
    expect(resp.status).toBe(400)
    expect(await resp.text()).toContain('缺少文件')
  })

  it('错误操作：超过 20MB 被 400 拒绝', async () => {
    const base = await startServer()
    const fd = new FormData()
    fd.set('file', new File([Buffer.alloc(MAX_UPLOAD + 1)], 'big.txt'))
    const resp = await fetch(base + '/review', { method: 'POST', body: fd })
    expect(resp.status).toBe(400)
    expect(await resp.text()).toContain('20MB')
  })
})
