/**
 * Agent 用户会话模拟：模拟 AGH 会话中模型连续调用工具链的真实次序——
 * 规划（先门检）→ 能力调用（切分/取证）→ 结果验证（通过才全流程评卷），
 * 含「门检不过即终止」的分支决策。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { executeDedup, executeGate, executeReview, executeSections } from '../src/index.js'

const DATA = fileURLToPath(new URL('../../../testdata/', import.meta.url))
const DOCS = fileURLToPath(new URL('../../../docs/', import.meta.url))
const read = (p: string) => readFileSync(DATA + p, 'utf-8')

const CORPUS = [
  { name: 'source1.txt', text: read('corpus/source1.txt') },
  { name: 'source2.txt', text: read('corpus/source2.txt') },
]

interface GateOut {
  passed: boolean
  word_count: number
  duplication_rate: number
  format_issues: string[]
  warnings: string[]
}

describe('AGH 会话式工具链调用（agent 旅程）', () => {
  it('旅程 A（合规投稿）：门检 → 章节取证 → 查重取证 → 全流程评卷', async () => {
    const paper = read('paper_good.md')

    // 步骤①：规划先行，先跑硬性门检（门槛降到测试值 10000 恰好达标）
    const gate = (await executeGate({ text: paper, minWords: 10000, corpus: CORPUS })).structured as GateOut
    expect(gate.passed).toBe(true)
    expect(gate.word_count).toBe(10074) // Python 金标
    expect(gate.duplication_rate).toBe(0)
    expect(gate.format_issues).toEqual([])
    expect(gate.warnings).toEqual([])

    // 步骤②：通过门检才继续——章节切分（供结构团/格式员引用）
    const sections = (await executeSections({ text: paper, bodyCap: 120 })).structured as {
      count: number
      sections: { title: string; truncated: boolean }[]
    }
    expect(sections.count).toBeGreaterThanOrEqual(3)
    expect(sections.sections.every((s) => s.title.length > 0)).toBe(true)

    // 步骤③：分块查重取证（供重复检测员引用）
    const dedup = (await executeDedup({ text: paper, corpus: CORPUS, topK: 3 })).structured as {
      rate: number
      matches: unknown[]
    }
    expect(dedup.rate).toBe(0)
    expect(dedup.matches).toEqual([])

    // 步骤④：反馈验证通过 → 全流程评卷（mock，需审批由 AGH 侧处理）
    const review = (await executeReview({
      paperPath: DATA + 'paper_good.md',
      outPath: DOCS + '会话模拟评卷报告.html',
      minWords: 10000,
      corpusDir: DATA + 'corpus',
      mock: true,
    })).structured as {
      gate_passed: boolean
      final_score: number
      passed: boolean
      vetoed: boolean
      panels: { panel: string; score: number; max: number }[]
      report_path: string
    }
    expect(review.gate_passed).toBe(true)
    expect(review.panels.length).toBe(4)
    // 演示 mock（demoMockLLM）：内容25.3/结构22.3/语言11.7/规范11.7 → 71，且走否决通路
    expect(review.vetoed).toBe(true)
    expect(review.passed).toBe(false)
    expect(review.final_score).toBe(71)
  })

  it('旅程 B（不合格投稿）：门检打回后 agent 应终止流程，不再评卷', async () => {
    // 抄袭 + 字数不足 + 缺章节的投稿
    const plagiarized = read('corpus/source1.txt') + '\n补充一句扩展说明。'

    const gate = (await executeGate({ text: plagiarized, minWords: 10000, corpus: CORPUS })).structured as GateOut
    expect(gate.passed).toBe(false)
    expect(gate.duplication_rate).toBeGreaterThan(0.5) // 与语料高度重复
    expect(gate.format_issues.length).toBeGreaterThan(0) // 缺必备章节
    expect(gate.word_count).toBeLessThan(10000)

    // agent 分支决策：门检不过 → 不调用 thesis_review（此处以断言模拟该守卫）
    const shouldReview = gate.passed
    expect(shouldReview).toBe(false)
  })

  it('旅程 C（章节/查重证据读取）：demo 论文的切分与匹配摘录可供评卷员引用', async () => {
    const demo = read('demo_paper.txt')
    const sections = (await executeSections({ text: demo, bodyCap: 60 })).structured as {
      count: number
      sections: { title: string; body: string }[]
    }
    expect(sections.count).toBeGreaterThanOrEqual(1)
    expect(sections.sections[0]!.body.length).toBeLessThanOrEqual(60)

    // 语料不足 400 字块时无分块循环 → rate 0、matches 空（与原插件行为一致）
    const dedup = (await executeDedup({ text: demo, corpus: CORPUS, topK: 5 })).structured as {
      rate: number
      matches: unknown[]
    }
    expect(dedup.rate).toBe(0)
    expect(dedup.matches).toEqual([])
  })
})
