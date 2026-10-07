/**
 * 两级仲裁：团内分差仲裁（团长）+ 总仲裁（合成/否决/路线图）。
 * 对照 yanzheng/core/arbiter.py。团长与总仲裁使用 pro 档模型（思考模式）。
 * 所有仲裁动作写 ArbitrationLog 留痕，报告可回放；仲裁失败降级为均值，不阻断流水线。
 */

import type { LLMClient } from './llm/client.js'
import {
  newArbitrationLog,
  type ArbitrationLog,
  type FraudFinding,
  type PanelVerdict,
  type RoadmapItem,
  type ScoreSheet,
  type Severity,
} from './models.js'
import { PASS_LINE, SPREAD_RATIO_THRESHOLD, gradeOf, type PanelSpec } from './rubric.js'

const SEV_ORDER: Record<Severity, number> = { 严重: 0, 较重: 1, 轻微: 2 }

// ---------------------------------------------------------------------------
// 团内仲裁
// ---------------------------------------------------------------------------

/** 对一团评分表做分差检测：超阈值触发团长复核，去离群后合成维度分。 */
export async function panelArbitration(
  panel: PanelSpec,
  sheets: ScoreSheet[],
  client: LLMClient,
): Promise<PanelVerdict> {
  const logs: ArbitrationLog[] = []
  const full = panel.maxScore
  const scores = sheets.map((s) => s.score)
  const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0

  const log = (actor: string, action: string, detail: string) => {
    logs.push(newArbitrationLog('panel', actor, action, detail))
  }

  const spread = scores.length ? Math.max(...scores) - Math.min(...scores) : 0
  if (spread <= full * SPREAD_RATIO_THRESHOLD || sheets.length < 2) {
    log('团长', 'spread_ok', `分差 ${spread.toFixed(1)} 在阈值 ${(full * SPREAD_RATIO_THRESHOLD).toFixed(1)} 内，取均值 ${mean.toFixed(1)}`)
    return {
      panel: panel.panelId,
      panelName: panel.name,
      finalScore: round1(mean),
      maxScore: full,
      sheets,
      arbitration: logs,
    }
  }

  // 分差超阈值 → 团长复核（pro 档）
  log('团长', 're_review', `分差 ${spread.toFixed(1)} 超阈值，触发团长复核`)
  const detail = sheets.map((s) => ({
    judge: s.judgeName,
    score: s.score,
    deductions: s.deductions.map((d) => d.description),
    confidence: s.confidence,
  }))
  const messages = [
    {
      role: 'system' as const,
      content:
        `你是「${panel.name}」团长。三位评卷员对同一维度独立评分，分差过大，` +
        '需要你复核裁定：识别离群评分（依据是否充分、置信度高低），' +
        '给出合成后的最终维度分与理由。只输出JSON：' +
        '{"final_score": 数字, "drop_outlier": "评卷员名或null", "reason": "..."' +
        ', "arbitrated_deductions": [扣分点数组（合并去重）]}',
    },
    {
      role: 'user' as const,
      content:
        JSON.stringify(detail) + `\n维度满分 ${full}。MOCK_INSTRUCTION: panel_arb_${panel.panelId}`,
    },
  ]
  let final = mean
  try {
    const data = await client.chatJson(messages, { modelTier: 'pro', thinking: true })
    const parsed = Number(data.final_score ?? mean)
    final = Math.max(0, Math.min(full, Number.isFinite(parsed) ? parsed : mean))
    const drop = data.drop_outlier
    // Python `if drop:`：null/undefined/空串为假，其余（含数字0、字符串"null"）均视为有离群
    if (drop !== null && drop !== undefined && drop !== '') {
      log('团长', 'drop_outlier', `剔除离群评分：${String(drop)} — ${String(data.reason ?? '')}`)
    } else {
      log('团长', 're_scored', String(data.reason ?? '').slice(0, 200))
    }
  } catch (exc) {
    // 仲裁失败降级为均值
    log('团长', 'fallback', `团长复核失败（${String(exc)}），降级取均值 ${mean.toFixed(1)}`)
  }

  return {
    panel: panel.panelId,
    panelName: panel.name,
    finalScore: round1(final),
    maxScore: full,
    sheets,
    arbitration: logs,
  }
}

// ---------------------------------------------------------------------------
// 总仲裁
// ---------------------------------------------------------------------------

/** 总仲裁：合成总分 + 作假否决裁定 + 修改路线图。 */
export async function chiefArbitration(
  panelVerdicts: PanelVerdict[],
  allSheets: ScoreSheet[],
  fraudFindings: FraudFinding[],
  client: LLMClient,
  paperTitle = '',
): Promise<{
  finalScore: number
  grade: string
  passed: boolean
  vetoed: boolean
  vetoReasons: string[]
  revisionRoadmap: RoadmapItem[]
  replay: ArbitrationLog[]
}> {
  const logs: ArbitrationLog[] = []
  const total = panelVerdicts.reduce((acc, v) => acc + v.finalScore, 0)
  // 及格线按编制总分等比缩放（标准 100 分制下即 60 分）
  const totalMax = panelVerdicts.reduce((acc, v) => acc + v.maxScore, 0)
  const passLine = (PASS_LINE / 100) * (totalMax > 0 ? totalMax : 100)

  // 作假复核：只有"严重"级疑点进入否决复核
  const critical = fraudFindings.filter((f) => f.severity === '严重')
  let vetoed = false
  let vetoReasons: string[] = []

  if (critical.length) {
    const messages = [
      {
        role: 'system' as const,
        content:
          '你是毕业论文评卷总仲裁。作假审查评卷员报告了以下严重学术不端疑点，' +
          '请复核证据链并裁定是否一票否决。裁定标准：证据链完整（有具体定位、' +
          '可复现的验证证据）才否决；存疑则转为重扣分并建议人工复核。只输出JSON：' +
          '{"veto": true|false, "veto_reasons": [...], "downgrade_to_deduction": true|false,' +
          ' "reason": "..."}',
      },
      {
        role: 'user' as const,
        content:
          JSON.stringify(
            critical.map((f) => ({ type: f.fraudType, location: f.location, evidence: f.evidence })),
          ) + `\n论文：${paperTitle}\nMOCK_INSTRUCTION: chief_veto`,
      },
    ]
    try {
      const data = await client.chatJson(messages, { modelTier: 'pro', thinking: true })
      vetoed = Boolean(data.veto)
      vetoReasons = ((data.veto_reasons ?? []) as unknown[]).map(String)
      logs.push(
        newArbitrationLog('chief', '总仲裁', vetoed ? 'veto' : 'downgrade', String(data.reason ?? '').slice(0, 300)),
      )
    } catch (exc) {
      // 复核失败：保守处理为扣分+人工复核
      vetoed = false
      logs.push(newArbitrationLog('chief', '总仲裁', 'fallback', `否决复核失败（${String(exc)}），转人工复核`))
    }
  }

  // 修改路线图：汇总各团扣分点 + 作假疑点，按严重度排序去重
  const roadmap: RoadmapItem[] = []
  const seen = new Set<string>()
  const deductions = allSheets.flatMap((s) => s.deductions)
  for (const d of [...deductions].sort((a, b) => (SEV_ORDER[a.severity] ?? 3) - (SEV_ORDER[b.severity] ?? 3))) {
    const key = `${d.location}|${d.description.slice(0, 30)}`
    if (seen.has(key)) continue
    seen.add(key)
    roadmap.push({
      priority: roadmap.length + 1,
      severity: d.severity,
      issue: d.description,
      action: d.suggestion,
      location: d.location,
    })
  }
  for (const f of fraudFindings) {
    roadmap.push({
      priority: roadmap.length + 1,
      severity: f.severity,
      issue: `[作假审查] ${f.fraudType}`,
      action: f.suggestion,
      location: f.location,
    })
  }

  const passed = !vetoed && total >= passLine
  return {
    finalScore: round1(total),
    grade: gradeOf(total, totalMax > 0 ? totalMax : 100),
    passed,
    vetoed,
    vetoReasons,
    revisionRoadmap: roadmap.slice(0, 25),
    replay: logs,
  }
}

function round1(x: number): number {
  return Math.round(x * 10) / 10
}
