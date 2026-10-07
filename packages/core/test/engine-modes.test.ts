/**
 * 引擎多维行为测试：消融开关（judgesLimit / arbitration off）、无语料回避（abstain）、
 * 演示 mock 全流程（含否决通路与回放留痕）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { reviewPaper } from '../src/engine.js'
import { demoMockLLM } from '../src/llm/demo-mock.js'

const DATA = fileURLToPath(new URL('../../../testdata/', import.meta.url))
const DEMO_PAPER = readFileSync(DATA + 'demo_paper.txt', 'utf-8')

const PASSABLE_TEXT = '摘要 绪论 结论 参考文献 ' + '研究内容与实验数据。'.repeat(120)

describe('引擎消融与校准路径', () => {
  it('judgesLimit=1：每团只剩 1 名评卷员', async () => {
    const report = await reviewPaper({ text: PASSABLE_TEXT, title: '消融-单员', minWords: 500, judgesLimit: 1 })
    expect(report.panels.length).toBe(4)
    for (const v of report.panels) {
      expect(v.sheets.length).toBe(1)
    }
    expect(report.finalScore).toBeGreaterThan(0)
    expect(report.usageSummary.config).toMatchObject({ judges_limit: 1 })
  })

  it('arbitrationEnabled=false：跳过两级仲裁，直接均值', async () => {
    const report = await reviewPaper({
      text: PASSABLE_TEXT,
      title: '消融-无仲裁',
      minWords: 500,
      arbitrationEnabled: false,
    })
    const actions = report.replay.map((l) => l.action)
    expect(actions.filter((a) => a === 'arb_disabled').length).toBeGreaterThanOrEqual(4)
    // 无复核时保守：默认 mock 无作假发现 → 分数≥60 即通过
    expect(report.finalScore).toBeGreaterThan(0)
  })

  it('无语料：查重评卷员回避（abstain 留痕），非满分', async () => {
    const report = await reviewPaper({ text: PASSABLE_TEXT, title: '无语料回避', minWords: 500 })
    const norms = report.panels.find((v) => v.panel === 'norms')!
    expect(norms.sheets.length).toBe(2) // 3 员中查重员回避
    expect(norms.arbitration.some((l) => l.action === 'abstain')).toBe(true)
    expect(norms.arbitration.some((l) => l.detail.includes('回避'))).toBe(true)
  })

  it('演示 mock 全流程：13 员 + 团长均值复核 + 总仲裁否决 + 回放留痕', async () => {
    const corpus = {
      'ref_a.txt': '深度学习模型在图像分类任务中的应用综述。'.repeat(50),
      'ref_b.txt': '校园垃圾分类政策实施效果评估与对策研究。'.repeat(50),
    }
    const report = await reviewPaper({
      text: DEMO_PAPER,
      title: '面向校园场景的智能垃圾分类系统设计与实现',
      corpus,
      mockFn: demoMockLLM,
      minWords: 1000,
    })
    expect(report.gate?.passed).toBe(true)
    expect(report.gate?.wordCount).toBe(1267)
    expect(report.panels.length).toBe(4)
    expect(report.panels.reduce((a, v) => a + v.sheets.length, 0)).toBe(13)
    // 演示 mock 走否决通路：content_fraud 2 条（数据不一致+方法矛盾）+ norms_citation 1 条（引用捏造）
    // 注：作假发现现在从全部评卷员收集（自定义编制的审查员也能进否决通道）
    expect(report.fraudFindings.length).toBe(3)
    expect(report.vetoed).toBe(true)
    expect(report.vetoReasons.length).toBe(2)
    // content 团 31/26/24/20 分差 11 > 40*0.15=6 → 团长复核，取均值
    const content = report.panels.find((v) => v.panel === 'content')!
    expect(content.arbitration.some((l) => l.action === 're_review')).toBe(true)
    // 修改路线图按严重度排序且去重
    expect(report.revisionRoadmap.length).toBeGreaterThan(0)
    expect(report.revisionRoadmap[0]!.severity).toBe('严重')
    // 回放含 chief veto 留痕
    expect(report.replay.some((l) => l.level === 'chief' && l.action === 'veto')).toBe(true)
    expect(report.usageSummary.config).toMatchObject({ arbitration_enabled: true })
  })

  it('门检不过时短路：不进入评卷环节', async () => {
    const report = await reviewPaper({ text: '太短', title: '打回', minWords: 10000 })
    expect(report.gate?.passed).toBe(false)
    expect(report.panels).toEqual([])
    expect(report.finalScore).toBe(0)
  })
})
