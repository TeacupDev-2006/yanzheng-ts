/**
 * 评卷员基类：统一 prompt 构造 + 评分表解析 + skill 调用编排。
 * 对照 yanzheng/judges/base_judge.py。skill 失败自动降级为纯 LLM 评卷，不阻断主流程。
 */

import type { ChatMessage, LLMClient } from '../llm/client.js'
import { countWords } from '../gates/gates.js'
import {
  parseSeverity,
  type DeductionPoint,
  type ScoreSheet,
  type Severity,
} from '../models.js'
import { CONFIDENCE_FLOOR, type JudgeSpec } from '../rubric.js'
import { splitSections } from '../skills/pdf-parse.js'
import { runSimilarityCheck } from '../skills/similarity.js'
import { runCitationCheck } from '../skills/citation.js'
import { runDataConsistency } from '../skills/consistency.js'
import { runLiteratureReview } from '../skills/literature.js'

export interface JudgeContext {
  corpus: Record<string, string>
  online: boolean
  [key: string]: unknown
}

/** 执行 skill（确定性工具，非 LLM）。失败不阻断评卷，返回 error 供评卷员参考。 */
export async function runSkill(
  skill: string,
  paperText: string,
  context: Partial<JudgeContext>,
): Promise<Record<string, unknown>> {
  try {
    if (skill === 'pdf_parse') {
      return {
        sections: splitSections(paperText).map((s) => ({
          title: s.title,
          body: s.body.slice(0, 800),
        })),
      }
    }
    if (skill === 'similarity_check') {
      return runSimilarityCheck(paperText, (context.corpus ?? {}) as Record<string, string>) as unknown as Record<string, unknown>
    }
    if (skill === 'citation_check') {
      return (await runCitationCheck(paperText, context.online ?? false)) as unknown as Record<string, unknown>
    }
    if (skill === 'data_consistency') {
      return runDataConsistency(paperText) as unknown as Record<string, unknown>
    }
    if (skill === 'literature_review') {
      return (await runLiteratureReview(paperText, context.online ?? false)) as unknown as Record<string, unknown>
    }
    return { error: `未知 skill: ${skill}` }
  } catch (exc) {
    return { error: `${skill} 执行失败: ${String(exc)}` }
  }
}

export const SCORE_SHEET_SPEC = `{
  "score": <0到满分之间的数字，保留1位小数>,
  "confidence": <0到1之间的数字，表示你对本次评分的确信度>,
  "deductions": [
    {
      "severity": "轻微|较重|严重",
      "location": "章节/段落定位",
      "description": "问题描述",
      "suggestion": "具体修改建议",
      "deduction": <该条建议扣分，数字>
    }
  ],
  "fraud_findings": [
    {
      "fraud_type": "引用捏造|数据不一致|结果与方法矛盾",
      "location": "定位",
      "evidence": "证据描述（必须具体）",
      "severity": "轻微|较重|严重"
    }
  ],
  "evidence": ["引用的证据来源id或描述", "..."]
}`

export class BaseJudge {
  constructor(
    readonly spec: JudgeSpec,
    private readonly client: LLMClient,
  ) {}

  buildMessages(
    paperText: string,
    skillResults: Record<string, Record<string, unknown>>,
    fullScore: number,
  ): ChatMessage[] {
    let skillBlock = ''
    for (const [name, res] of Object.entries(skillResults)) {
      skillBlock += `\n【skill:${name} 结果】\n${JSON.stringify(res).slice(0, 3500)}\n`
    }

    // 论文统计信息：给评卷员客观规模参照，减少凭篇幅印象打分的漂移
    const words = countWords(paperText)
    const sections = splitSections(paperText)
    const stats =
      `论文规模：约 ${words} 字，${sections.length} 个章节（` +
      `${sections.slice(0, 8).map((s) => s.title.slice(0, 12)).join(', ')}…）\n`

    const system =
      `你是毕业论文评审中的「${this.spec.name}」，只负责一个视角：${this.spec.persona}\n` +
      `本维度满分 ${fullScore} 分。你独立评卷，看不到其他评卷员的评分。\n` +
      '评分要求：\n' +
      '1. 严格按视角评分，不越界评价其他维度；\n' +
      '2. 每个扣分点必须给出定位、问题描述、可执行的修改建议；\n' +
      '3. 证据不足的判断必须降低 confidence，不得臆断；\n' +
      '4. skill 标注 abstain 的项目回避不打分，在 evidence 中注明；\n' +
      '5. 只输出如下 JSON（不要任何多余文字）：\n' +
      SCORE_SHEET_SPEC
    const user =
      `【论文全文】\n${paperText.slice(0, 60000)}\n${stats}${skillBlock}` +
      `\nMOCK_INSTRUCTION: ${this.spec.judgeId}`
    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]
  }

  parseSheet(data: Record<string, unknown>, fullScore: number): ScoreSheet {
    const rawScore = Number(data.score ?? fullScore * 0.6)
    const score = Math.max(0, Math.min(fullScore, Number.isFinite(rawScore) ? rawScore : fullScore * 0.6))
    const deductions: DeductionPoint[] = []
    for (const item of (data.deductions as Record<string, unknown>[] | undefined) ?? []) {
      const severity = parseSeverity(item?.severity ?? '轻微')
      if (!severity) continue
      deductions.push({
        severity: severity as Severity,
        location: String(item?.location ?? ''),
        description: String(item?.description ?? ''),
        suggestion: String(item?.suggestion ?? ''),
        deduction: Number(item?.deduction ?? 0) || 0,
      })
    }
    const fraud = (data.fraud_findings ?? []) as unknown[]
    const meta = (data._meta ?? {}) as Record<string, unknown>
    return {
      judgeId: this.spec.judgeId,
      judgeName: this.spec.name,
      panel: this.spec.panel,
      score,
      maxScore: fullScore,
      deductions,
      evidence: ((data.evidence ?? []) as unknown[]).map(String).slice(0, 10),
      confidence: Number(data.confidence ?? 0.8) || 0.8,
      model: String(meta.model ?? ''),
      rawResponse: JSON.stringify(fraud).slice(0, 2000),
    }
  }

  /** 执行 skills → LLM 打分 → 解析。skill 失败自动降级为纯 LLM 评卷。 */
  async review(paperText: string, fullScore: number, context: JudgeContext): Promise<ScoreSheet> {
    const skillResults: Record<string, Record<string, unknown>> = {}
    for (const s of this.spec.skills) {
      skillResults[s] = await runSkill(s, paperText, context)
    }
    let messages = this.buildMessages(paperText, skillResults, fullScore)
    let data: Record<string, unknown>
    try {
      data = await this.client.chatJson(messages, { modelTier: this.spec.modelTier })
    } catch {
      // 降级：去掉 skill 结果重试一次（异常处理闭环：工具失败不阻断主流程）
      messages = this.buildMessages(paperText, {}, fullScore)
      data = await this.client.chatJson(messages, { modelTier: this.spec.modelTier })
    }
    const sheet = this.parseSheet(data, fullScore)
    if (sheet.confidence < CONFIDENCE_FLOOR) {
      sheet.evidence.push('LOW_CONFIDENCE：建议人工复核该评卷员评分')
    }
    return sheet
  }
}
