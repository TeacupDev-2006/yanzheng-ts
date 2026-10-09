/** 实验③撤稿引用标记测试（Retraction Watch CSV 离线 fixture）。 */

import { describe, expect, it } from 'vitest'
import { loadRetractionIndex, matchRetraction, parseReferences } from '../src/skills/citation.js'

const CSV = `RetractionDOI,OriginalPaperDOI,Title,RetractionNature
10.1000/r1,10.1000/o1,"Deep Learning for Waste Classification","数据造假；结果不可靠"
10.1000/r2,10.1000/o2,"A Survey on Image Enhancement","重复发表"
,,"Qwen3 Technical Report","结果不可靠"
`

const REFS = `[1] 王强. 基于深度学习的垃圾图像分类研究. doi: 10.1000/o1. 2021.
[2] 李明. 无关的正常文献. 2022.
[3] Smith J. Qwen3 Technical Report. arXiv preprint. 2024.
`

describe('撤稿索引', () => {
  it('CSV 解析：DOI 与标题双索引', () => {
    const idx = loadRetractionIndex(CSV)
    expect(idx.size).toBe(5) // 2 DOI + 3 标题
    expect(idx.get('doi:10.1000/o1')!.reason).toContain('数据造假')
  })

  it('DOI 命中', () => {
    const idx = loadRetractionIndex(CSV)
    const [entry] = parseReferences(REFS)
    expect(matchRetraction(entry!, idx)?.doi).toBe('10.1000/o1')
  })

  it('标题模糊命中（无 DOI 的引用）', () => {
    const idx = loadRetractionIndex(CSV)
    const entries = parseReferences(REFS)
    expect(matchRetraction(entries[2]!, idx)?.title).toContain('Qwen3')
  })

  it('正常文献不误报', () => {
    const idx = loadRetractionIndex(CSV)
    const entries = parseReferences(REFS)
    expect(matchRetraction(entries[1]!, idx)).toBeNull()
  })
})

describe('实验③评测框架（core 侧断言）', () => {
  it('期望命中 [1,3]：hitRate=1、误报=0', () => {
    const idx = loadRetractionIndex(CSV)
    const entries = parseReferences(REFS)
    const hits = entries.filter((e) => matchRetraction(e, idx) !== null).map((e) => e.index)
    expect(hits.sort()).toEqual([1, 3])
    expect(entries.find((e) => e.index === 1 && matchRetraction(e, idx)) ? matchRetraction(entries[0]!, idx)?.reason : null).toContain('数据造假')
  })
})
