/** 撤稿索引从 reviewPaper → 评卷上下文 → citation_check 的传递测试（防回归）。 */

import { describe, expect, it } from 'vitest'
import { runSkill } from '../src/judges/base-judge.js'
import { loadRetractionIndex } from '../src/skills/citation.js'

const CSV = `RetractionDOI,OriginalPaperDOI,Title,RetractionNature
10.9999/rr1,10.9999/demo1,"Fabricated Results in Deep Learning Classification","数据造假"
`

const REFS_TEXT =
  '第一章 绪论\n本文引用如下文献。\n参考文献\n[1] 张三. 深度学习分类研究. doi: 10.9999/demo1. 2021.'

describe('retractions 传递（engine context → citation_check）', () => {
  it('runSkill 携带撤稿索引时，引用明细标记 retracted 与原因', async () => {
    const res = await runSkill('citation_check', REFS_TEXT, {
      corpus: {},
      online: false,
      retractions: loadRetractionIndex(CSV),
    })
    const details = res.details as { retracted: boolean; retraction_reason: string }[]
    expect(details[0]!.retracted).toBe(true)
    expect(details[0]!.retraction_reason).toContain('数据造假')
    expect(details[0]!.evidence).toContain('[已撤稿]')
  })

  it('不携带撤稿索引时行为不变（retracted=false）', async () => {
    const res = await runSkill('citation_check', REFS_TEXT, { corpus: {}, online: false })
    const details = res.details as { retracted: boolean }[]
    expect(details[0]!.retracted).toBe(false)
  })
})
