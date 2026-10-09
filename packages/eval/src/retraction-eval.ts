/**
 * 实验③：撤稿引用标记评测。
 * 构造含"已撤稿文献"的引用清单（真值已知），验证 loadRetractionIndex +
 * matchRetraction 的标记率与误报率；亦可对真实 Retraction Watch CSV 离线复跑。
 */

import { loadRetractionIndex, matchRetraction, parseReferences } from '@yanzheng/core'

export interface RetractionCase {
  /** 引用文本（[n] 格式） */
  refsText: string
  /** CSV 内容（Retraction Watch 风格） */
  csvText: string
  /** 应被标记的引用编号 */
  expectHit: number[]
}

export interface RetractionEvalResult {
  hitRate: number
  falsePositiveRate: number
  details: { index: number; retracted: boolean; reason: string }[]
}

export function runRetractionEval(c: RetractionCase): RetractionEvalResult {
  const index = loadRetractionIndex(c.csvText)
  const entries = parseReferences(c.refsText)
  const details = entries.map((e) => {
    const rec = matchRetraction(e, index)
    return { index: e.index, retracted: rec !== null, reason: rec?.reason ?? '' }
  })
  const hits = details.filter((d) => d.retracted).map((d) => d.index)
  const expect = new Set(c.expectHit)
  const tp = hits.filter((h) => expect.has(h)).length
  const fp = hits.filter((h) => !expect.has(h)).length
  return {
    hitRate: expect.size ? tp / expect.size : 1,
    falsePositiveRate: details.length - expect.size ? fp / (details.length - expect.size) : 0,
    details,
  }
}
