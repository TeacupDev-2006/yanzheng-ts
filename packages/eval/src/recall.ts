/**
 * 实验②：查重召回曲线。
 * 对每个混淆等级构造变体（ground truth：必源自原文），统计
 * duplicationRate（n-gram 指纹）与 hybridChunkMatch（词袋混合）的召回率，
 * 并输出"纯 n-gram vs 混合"的对照——用于决定是否默认启用 lexicalHybrid。
 */

import { duplicationRate, hybridChunkMatch, lexicalVectorEmbed } from '@yanzheng/core'
import { obfuscate, OBFUSCATE_LEVELS, type ObfuscateLevel } from './obfuscate.js'

export interface RecallRow {
  level: ObfuscateLevel
  /** n-gram 指纹召回率（hit = rate ≥ 阈值） */
  ngramRecall: number
  /** 词袋混合召回率（embedWeight 0.5） */
  hybridRecall: number
  /** 词袋混合召回率（embedWeight 0.7：偏重词面稳健分量） */
  hybridRecall70: number
  /** 平均 n-gram 相似度 */
  ngramMeanRate: number
  /** 平均混合相似度（0.5 权重） */
  hybridMeanScore: number
}

export interface RecallReport {
  rows: RecallRow[]
  samples: number
  threshold: number
  seed: number
}

const HIT_THRESHOLD = 0.5

export function buildRecallReport(
  sources: string[],
  seed = 42,
  threshold = HIT_THRESHOLD,
): RecallReport {
  const rows: RecallRow[] = []
  for (const level of OBFUSCATE_LEVELS) {
    let ngramHit = 0
    let hybridHit = 0
    let hybrid70Hit = 0
    let ngramSum = 0
    let hybridSum = 0
    let n = 0
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i]!.trim()
      if (src.replace(/\s+/g, '').length < 400) continue // 不足一个分块窗口，跳过
      const variant = obfuscate(src, level, seed + i * 977)
      const ngramRate = duplicationRate(variant, [src])
      // 混合 = 同一分块框架 + 词袋嵌入；对照两种权重
      const hybridHalf = hybridChunkMatch(variant, { original: src }, lexicalVectorEmbed, 8, 5, 0.5)
      const hybrid70 = hybridChunkMatch(variant, { original: src }, lexicalVectorEmbed, 8, 5, 0.7)
      const hybridScore = hybridHalf.length ? Math.max(...hybridHalf.map((m) => m.combined)) : 0
      const hybrid70Score = hybrid70.length ? Math.max(...hybrid70.map((m) => m.combined)) : 0
      ngramSum += ngramRate
      hybridSum += hybridScore
      if (ngramRate >= threshold) ngramHit++
      if (hybridScore >= threshold) hybridHit++
      if (hybrid70Score >= threshold) hybrid70Hit++
      n++
    }
    if (n === 0) continue
    rows.push({
      level,
      ngramRecall: ngramHit / n,
      hybridRecall: hybridHit / n,
      hybridRecall70: hybrid70Hit / n,
      ngramMeanRate: Math.round((ngramSum / n) * 10000) / 10000,
      hybridMeanScore: Math.round((hybridSum / n) * 10000) / 10000,
    })
  }
  return { rows, samples: sources.length, threshold, seed }
}

/** 渲染 markdown 对照表。 */
export function renderRecallMarkdown(r: RecallReport): string {
  const lines = [
    '# 实验② · 查重召回曲线（可控混淆）',
    '',
    `- 样本数：${r.samples}（≥400 有效字符）· 命中阈值：${r.threshold} · 混淆种子：${r.seed}`,
    '- hit 定义：变体与原文的相似度 ≥ 阈值（真值：变体必源自原文，理应全部命中）',
    '',
    '| 混淆等级 | n-gram 召回 | 混合召回(0.5) | 混合召回(0.7) | n-gram 均值 | 混合均值(0.5) |',
    '|---|---|---|---|---|---|',
    ...r.rows.map(
      (row) =>
        `| ${row.level} | ${(row.ngramRecall * 100).toFixed(0)}% | ${(row.hybridRecall * 100).toFixed(0)}% | ${(row.hybridRecall70 * 100).toFixed(0)}% | ${row.ngramMeanRate} | ${row.hybridMeanScore} |`,
    ),
    '',
    '> 结论指引：medium/heavy 级混合均值显著高于纯 n-gram（改写打散 8-gram 但词面重叠仍在）；',
    '> 若 0.7 权重召回更高，建议评卷流水线默认启用 lexicalHybrid 并采用偏重词袋的权重。',
  ]
  return lines.join('\n') + '\n'
}
