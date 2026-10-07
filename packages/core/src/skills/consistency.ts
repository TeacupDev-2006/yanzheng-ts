/**
 * 数据核验 skill（自建，作假审查专用）：跨章节数字/统计量交叉比对。
 * 对照 yanzheng/skills/data_consistency.py。抽取全文百分比断言，
 * 同指标名（上下文关键词重合）但数值不同即报告为待人工确认证据。
 */

import { PY_WS_COLLAPSE } from './ws.js'

export interface NumberClaim {
  value: string
  context: string
  section: string
}

const PCT_PAT = /(\d+(?:\.\d+)?)\s*%/g

/** 抽取百分比断言及其上下文。 */
export function extractPercentClaims(text: string, window = 40): NumberClaim[] {
  const claims: NumberClaim[] = []
  for (const m of text.matchAll(PCT_PAT)) {
    const start = Math.max(0, (m.index ?? 0) - window)
    const end = Math.min(text.length, (m.index ?? 0) + m[0].length + window)
    const ctx = text.slice(start, end).replace(PY_WS_COLLAPSE, ' ')
    claims.push({ value: `${m[1]}%`, context: ctx, section: '' })
  }
  return claims
}

const STOPWORDS = new Set(['结果', '方法', '实验', '本文', '模型', '如表', '所示'])

function keywords(ctx: string): Set<string> {
  const out = new Set<string>()
  for (const w of ctx.matchAll(/[\u4e00-\u9fffA-Za-z]{2,6}/g)) {
    if (w[0]!.length >= 2 && !STOPWORDS.has(w[0]!)) out.add(w[0]!)
  }
  return out
}

/** 同指标名（上下文关键词重合≥2）但数值不同的现象对。近似实现，仲裁裁定严重度。 */
export function findInconsistentPairs(claims: NumberClaim[], digits = 1): string[] {
  const out: string[] = []
  for (let i = 0; i < claims.length; i++) {
    const a = claims[i]!
    for (let j = i + 1; j < claims.length; j++) {
      const b = claims[j]!
      if (a.value === b.value) continue
      const ka = keywords(a.context)
      const kb = keywords(b.context)
      let overlap = 0
      for (const k of ka) if (kb.has(k)) overlap++
      if (overlap >= 2) {
        const va = Number.parseFloat(a.value.replace(/%$/, ''))
        const vb = Number.parseFloat(b.value.replace(/%$/, ''))
        if (Math.abs(va - vb) > 10 ** -digits) {
          // 数值不同即报告，仲裁裁定严重度
          out.push(
            `指标表述不一致：'${a.value}'（…${a.context.slice(0, 30)}…） vs ` +
              `'${b.value}'（…${b.context.slice(0, 30)}…）`,
          )
          break // 每个值只报一次
        }
      }
    }
  }
  return out
}

export interface DataConsistencyResult {
  claims: number
  inconsistencies: string[]
  note: string
}

/** skill 入口：返回 {"claims", "inconsistencies"}。 */
export function runDataConsistency(text: string): DataConsistencyResult {
  const claims = extractPercentClaims(text)
  const inconsistent = findInconsistentPairs(claims)
  return {
    claims: claims.length,
    inconsistencies: inconsistent.slice(0, 20),
    note: '确定性近似检查，最终裁定由作假审查评卷员+总仲裁完成',
  }
}
