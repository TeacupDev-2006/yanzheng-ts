/**
 * 实验①：AI 评分 vs 人类评分对照。
 * 每个样本构造"摘要级论文骨架"（补齐必备章节以通过门检），跑研证流水线后
 * 计算 Spearman 秩相关（AI 百分制 vs 人类 rating×10）、分布重合度，
 * 并把研证扣分点与人类评审文本并列供定性阅读。
 *
 * 声称边界：mock 模式分数为常量，对照指标无意义（仅验证管线）；真实模式的
 * 结论应表述为"分布/排名一致性"，不可表述为"AI 评分被证明正确"。
 */

import { reviewPaper, type ReviewReport } from '@yanzheng/core'
import type { MockFn } from '@yanzheng/core'
import type { OpenReviewSample } from './openreview.js'

export interface SamplePair {
  id: string
  title: string
  aiScore: number
  humanScore10: number | null
  report: ReviewReport
  reviewsText: string[]
}

export interface ScoreComparison {
  pairs: SamplePair[]
  spearman: number | null
  overlap: number | null
  mode: 'mock' | 'real'
  note: string
}

/** 摘要 → 摘要级论文骨架（满足必备章节门检；明确标注为对照实验文本）。 */
export function sampleToPaper(s: OpenReviewSample): string {
  return [
    s.title,
    '',
    '摘要',
    s.abstract,
    '',
    '关键词：对照实验；自动评审',
    '',
    '绪论',
    '本文文本由 OpenReview 公开评审样本构造，用于自动评审系统的对照实验。',
    '',
    '结论',
    '结论同摘要所述。',
    '',
    '参考文献',
    '[1] OpenReview Public Reviews. 2023.',
  ].join('\n')
}

/** Spearman 秩相关（tie 取平均秩）。样本 <3 或全常数返回 null。 */
export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length < 3 || xs.length !== ys.length) return null
  const rank = (arr: number[]): number[] => {
    const idx = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
    const r = new Array<number>(arr.length)
    let i = 0
    while (i < idx.length) {
      let j = i
      while (j + 1 < idx.length && idx[j + 1]!.v === idx[i]!.v) j++
      const avg = (i + j) / 2 + 1
      for (let k = i; k <= j; k++) r[idx[k]!.i] = avg
      i = j + 1
    }
    return r
  }
  const rx = rank(xs)
  const ry = rank(ys)
  const n = xs.length
  let sum = 0
  for (let i = 0; i < n; i++) {
    const d = rx[i]! - ry[i]!
    sum += d * d
  }
  return 1 - (6 * sum) / (n * (n * n - 1))
}

/** 分布重合度（10 桶直方图的交集占比）。 */
export function histogramOverlap(xs: number[], ys: number[], buckets = 10, max = 100): number | null {
  if (!xs.length || xs.length !== ys.length) return null
  const hx = new Array<number>(buckets).fill(0)
  const hy = new Array<number>(buckets).fill(0)
  for (const v of xs) hx[Math.min(buckets - 1, Math.floor((v / max) * buckets))]!++
  for (const v of ys) hy[Math.min(buckets - 1, Math.floor((v / max) * buckets))]!++
  const nx = xs.length
  const ny = ys.length
  let inter = 0
  for (let i = 0; i < buckets; i++) inter += Math.min(hx[i]! / nx, hy[i]! / ny)
  return inter / buckets
}

export interface CompareOptions {
  samples: OpenReviewSample[]
  /** 仅对照带人类评分的样本 */
  apiKey?: string | null
  mockFn?: MockFn | null
  baseUrl?: string
  modelFlash?: string
  modelPro?: string
  thinkingStyle?: 'deepseek' | 'off'
  minWords?: number
}

export async function runScoreComparison(opts: CompareOptions): Promise<ScoreComparison> {
  const mode = opts.apiKey ? 'real' : 'mock'
  const pairs: SamplePair[] = []
  for (const s of opts.samples) {
    const report = await reviewPaper({
      text: sampleToPaper(s),
      title: s.title,
      corpus: {},
      apiKey: opts.apiKey,
      mockFn: opts.apiKey ? null : (opts.mockFn ?? undefined),
      baseUrl: opts.baseUrl,
      modelFlash: opts.modelFlash,
      modelPro: opts.modelPro,
      thinkingStyle: opts.thinkingStyle,
      minWords: opts.minWords ?? 30,
    })
    if (!report.gate?.passed) continue // 摘要过短等打回样本跳过
    pairs.push({
      id: s.id,
      title: s.title,
      aiScore: report.finalScore,
      humanScore10: s.humanScore === null ? null : Math.round(s.humanScore * 10 * 10) / 10,
      report,
      reviewsText: s.reviewsText,
    })
  }
  const both = pairs.filter((p) => p.humanScore10 !== null)
  const mock = mode === 'mock'
  const ai = both.map((p) => p.aiScore)
  const hu = both.map((p) => p.humanScore10!)
  const constant = new Set(ai).size < 2 || new Set(hu).size < 2
  return {
    pairs,
    spearman: mock || constant ? null : spearman(ai, hu),
    overlap: mock || constant ? null : histogramOverlap(ai, hu),
    mode,
    note: mock
      ? 'mock 模式：AI 分数为常量，对照指标无意义，仅验证评测管线。'
      : `真实模式：n=${both.length}；结论应表述为"排名/分布一致性"。`,
  }
}

export function renderComparisonMarkdown(c: ScoreComparison): string {
  const lines = [
    '# 实验① · AI 评分 vs 人类评分对照（OpenReview）',
    '',
    `- 模式：${c.mode} · 配对样本：${c.pairs.length}（带人类评分 ${c.pairs.filter((p) => p.humanScore10 !== null).length}）`,
    `- Spearman 秩相关：${c.spearman === null ? 'n/a' : c.spearman.toFixed(3)}`,
    `- 分布重合度（10 桶交集）：${c.overlap === null ? 'n/a' : (c.overlap * 100).toFixed(1) + '%'}`,
    `- 说明：${c.note}`,
    '',
    '| # | 论文 | AI 分 | 人类分(×10) | 研证扣分点数 |',
    '|---|---|---|---|---|',
    ...c.pairs.map(
      (p, i) =>
        `| ${i + 1} | ${p.title.slice(0, 40).replace(/\|/g, '/')} | ${p.aiScore} | ${p.humanScore10 ?? '—'} | ${p.report.revisionRoadmap.length} |`,
    ),
    '',
    '> 定性对照：每篇的人类评审原文与研证扣分点已存于 JSON 输出（pairs[].reviewsText / pairs[].report.panels）。',
  ]
  return lines.join('\n') + '\n'
}
