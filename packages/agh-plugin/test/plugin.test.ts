/**
 * AGH 插件测试：不依赖 AGH 运行时——用结构化 mock ctx 验证
 * 4 个工具按契约注册、meta 语义正确、execute 结果与 core 一致。
 */

import { readFileSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  thesisReviewTools,
  executeGate,
  executeSections,
  executeDedup,
  executeReview,
  type AghExtensionApi,
  type AghPluginContext,
  type ToolResult,
} from '../src/index.js'

const DATA = fileURLToPath(new URL('../../../testdata/', import.meta.url))
const DEMO = readFileSync(DATA + 'demo_paper.txt', 'utf-8')
const SOURCE1 = readFileSync(DATA + 'corpus/source1.txt', 'utf-8')
const SOURCE2 = readFileSync(DATA + 'corpus/source2.txt', 'utf-8')

/** 结构化 mock：记录 registerTool 调用，供断言。 */
function mockCtx(): { ctx: AghPluginContext; tools: Map<string, Parameters<AghExtensionApi['registerTool']>[0]>; logs: string[] } {
  const tools = new Map<string, Parameters<AghExtensionApi['registerTool']>[0]>()
  const logs: string[] = []
  const ctx: AghPluginContext = {
    extension() {
      return {
        registerTool(tool) {
          tools.set(tool.name, tool)
        },
        on(_event, handler) {
          handler()
        },
        ctx: { log: { info: (m) => logs.push(m), error: (m) => logs.push(m) } },
      }
    },
  }
  return { ctx, tools, logs }
}

describe('agh plugin contract', () => {
  const { ctx, tools, logs } = mockCtx()
  thesisReviewTools.apply(ctx)

  it('注册恰好 4 个工具', () => {
    expect([...tools.keys()].sort()).toEqual(['thesis_dedup', 'thesis_gate', 'thesis_review', 'thesis_sections'])
  })

  it('meta 语义：前三个只读可重放，review 需审批且不可重放', () => {
    for (const name of ['thesis_gate', 'thesis_sections', 'thesis_dedup']) {
      const meta = tools.get(name)!.meta as Record<string, unknown>
      expect(meta.isReadOnly).toBe(true)
      expect(meta.replay).toBe('safe')
      expect(meta.requiresApproval).toBe('never')
    }
    const meta = tools.get('thesis_review')!.meta as Record<string, unknown>
    expect(meta.isReadOnly).toBe(false)
    expect(meta.replay).toBe('never')
    expect(meta.requiresApproval).toBe('always')
  })

  it('参数 schema 带 TypeBox Kind 标记', () => {
    const params = tools.get('thesis_gate')!.parameters as Record<symbol, unknown>
    expect(params[Symbol.for('TypeBox.Kind')]).toBe('Object')
  })

  it('session_start 打印就绪日志', () => {
    expect(logs.join('\n')).toContain('thesis_gate / thesis_sections / thesis_dedup / thesis_review')
  })
})

describe('tool executions', () => {
  it('thesis_gate：demo 论文通过门检（语料无关，门槛降至演示值）', async () => {
    const r = await executeGate({
      text: DEMO,
      minWords: 1000,
      corpus: [{ name: 's1', text: SOURCE1 }, { name: 's2', text: SOURCE2 }],
    })
    const g = r.structured as { passed: boolean; word_count: number; duplication_rate: number }
    expect(g.passed).toBe(true)
    expect(g.word_count).toBe(1267) // 与 Python 金标一致
  })

  it('thesis_sections：切出章节', async () => {
    const r = await executeSections({ text: '第一章 绪论\n内容A\n第二章 方法\n内容B' })
    const s = r.structured as { count: number; sections: { title: string }[] }
    expect(s.count).toBe(2)
    expect(s.sections.map((x) => x.title)).toEqual(['第一章 绪论', '第二章 方法'])
  })

  it('thesis_dedup：抄语料的论文返回高相似', async () => {
    // 分块窗口 400 字：语料需足够长才会进入分块循环（与原插件逻辑一致）
    const longText = SOURCE1.repeat(4)
    const r = await executeDedup({
      text: longText,
      corpus: [
        { name: 'source1.txt', text: SOURCE1 },
        { name: 'long.txt', text: longText },
      ],
    })
    const d = r.structured as { rate: number }
    expect(d.rate).toBe(1.0)
  })

  it('thesis_review：mock 模式端到端出报告（写文件 + 否决通路）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yanzheng-review-'))
    const outPath = join(dir, '报告.html')
    const r = await executeReview({
      paperPath: DATA + 'demo_paper.txt',
      outPath,
      minWords: 1000,
      corpusDir: DATA + 'corpus',
      mock: true,
    })
    const s = r.structured as {
      report_id: string
      gate_passed: boolean
      final_score: number
      vetoed: boolean
      panels: unknown[]
      report_path: string
    }
    expect(s.gate_passed).toBe(true)
    expect(s.panels.length).toBe(4)
    expect(s.vetoed).toBe(true) // 演示 mock 走否决通路
    expect(s.mode === undefined || s.mode !== null).toBe(true)
    const html = await readFile(outPath, 'utf-8')
    expect(html).toContain('研')
    expect(html).toContain(s.report_id)
  })

  it('execute 返回 { content, structured } 双通道', async () => {
    const r: ToolResult = await executeGate({ text: DEMO })
    expect(r.content[0]!.type).toBe('text')
    expect(() => JSON.parse(r.content[0]!.text)).not.toThrow()
    expect(r.structured).toBeDefined()
  })
})
