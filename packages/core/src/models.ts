/**
 * 核心数据结构：评分表、扣分点、作假发现、仲裁记录、最终报告。
 * 对照 yanzheng/core/models.py 逐类移植；toDict 输出 snake_case，与原 JSON 报告字段一致。
 */

export type Severity = '轻微' | '较重' | '严重'
export const SEVERITIES: readonly Severity[] = ['轻微', '较重', '严重']

export function parseSeverity(v: unknown): Severity | null {
  return SEVERITIES.includes(v as Severity) ? (v as Severity) : null
}

export type FraudType = '引用捏造' | '数据不一致' | '结果与方法矛盾'
export const FRAUD_TYPES: readonly FraudType[] = ['引用捏造', '数据不一致', '结果与方法矛盾']
export const DEFAULT_FRAUD_TYPE: FraudType = '数据不一致'

export function parseFraudType(v: unknown): FraudType {
  return FRAUD_TYPES.includes(v as FraudType) ? (v as FraudType) : DEFAULT_FRAUD_TYPE
}

/** 一条扣分点：等级 + 定位 + 问题描述 + 修改建议。 */
export interface DeductionPoint {
  severity: Severity
  location: string
  description: string
  suggestion: string
  deduction: number
}

/** 作假审查疑点（来自确定性 skills 的证据 + LLM 判断）。 */
export interface FraudFinding {
  fraudType: FraudType
  location: string
  evidence: string
  severity: Severity
  suggestion: string
}

export function newFraudFinding(
  fraudType: FraudType,
  location: string,
  evidence: string,
  severity: Severity,
): FraudFinding {
  return { fraudType, location, evidence, severity, suggestion: '提交总仲裁复核证据链' }
}

/** 一名评卷员的评分表（结构化、可回放）。 */
export interface ScoreSheet {
  judgeId: string
  judgeName: string
  panel: string
  score: number
  maxScore: number
  deductions: DeductionPoint[]
  evidence: string[]
  confidence: number
  model: string
  rawResponse: string
}

/** 一次仲裁动作的留痕（团内或总仲裁）。 */
export interface ArbitrationLog {
  level: 'panel' | 'chief'
  actor: string
  action: string
  detail: string
  timestamp: number
}

export function newArbitrationLog(
  level: ArbitrationLog['level'],
  actor: string,
  action: string,
  detail: string,
): ArbitrationLog {
  return { level, actor, action, detail, timestamp: Date.now() / 1000 }
}

/** 一个评审团的最终裁定。 */
export interface PanelVerdict {
  panel: string
  panelName: string
  finalScore: number
  maxScore: number
  sheets: ScoreSheet[]
  arbitration: ArbitrationLog[]
}

/** 硬性门检结果（全部确定性计算）。 */
export interface GateResult {
  passed: boolean
  wordCount: number
  minWords: number
  duplicationRate: number
  dupThreshold: number
  formatIssues: string[]
  warnings: string[]
}

export interface RoadmapItem {
  priority: number
  severity: string
  issue: string
  action: string
  location: string
}

export interface UsageSummary {
  elapsed_seconds?: number
  models: Record<string, { calls: number; prompt_tokens: number; completion_tokens: number }>
  config?: Record<string, unknown>
}

/** 最终评卷报告。 */
export interface ReviewReport {
  reportId: string
  paperTitle: string
  mode: 'mock' | 'real'
  gate: GateResult | null
  panels: PanelVerdict[]
  finalScore: number
  passed: boolean
  vetoed: boolean
  vetoReasons: string[]
  fraudFindings: FraudFinding[]
  revisionRoadmap: RoadmapItem[]
  replay: ArbitrationLog[]
  usageSummary: UsageSummary
}

export function newReportId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

export function createReviewReport(paperTitle: string, mode: 'mock' | 'real'): ReviewReport {
  return {
    reportId: newReportId(),
    paperTitle,
    mode,
    gate: null,
    panels: [],
    finalScore: 0,
    passed: false,
    vetoed: false,
    vetoReasons: [],
    fraudFindings: [],
    revisionRoadmap: [],
    replay: [],
    usageSummary: { models: {} },
  }
}

// ---------------------------------------------------------------------------
// snake_case 序列化（与 Python 版报告 JSON 字段一一对应）
// ---------------------------------------------------------------------------

export function deductionToDict(d: DeductionPoint) {
  return {
    severity: d.severity,
    location: d.location,
    description: d.description,
    suggestion: d.suggestion,
    deduction: d.deduction,
  }
}

export function fraudFindingToDict(f: FraudFinding) {
  return {
    fraud_type: f.fraudType,
    location: f.location,
    evidence: f.evidence,
    severity: f.severity,
    suggestion: f.suggestion,
  }
}

export function scoreSheetToDict(s: ScoreSheet) {
  return {
    judge_id: s.judgeId,
    judge_name: s.judgeName,
    panel: s.panel,
    score: s.score,
    max_score: s.maxScore,
    deductions: s.deductions.map(deductionToDict),
    evidence: s.evidence,
    confidence: s.confidence,
    model: s.model,
  }
}

export function arbitrationLogToDict(a: ArbitrationLog) {
  return { level: a.level, actor: a.actor, action: a.action, detail: a.detail, timestamp: a.timestamp }
}

export function gateResultToDict(g: GateResult) {
  return {
    passed: g.passed,
    word_count: g.wordCount,
    min_words: g.minWords,
    dup_threshold: g.dupThreshold,
    duplication_rate: round4(g.duplicationRate),
    format_issues: g.formatIssues,
    warnings: g.warnings,
  }
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}

export function panelVerdictToDict(v: PanelVerdict) {
  return {
    panel: v.panel,
    panel_name: v.panelName,
    final_score: v.finalScore,
    max_score: v.maxScore,
    sheets: v.sheets.map(scoreSheetToDict),
    arbitration: v.arbitration.map(arbitrationLogToDict),
  }
}

export function reviewReportToDict(r: ReviewReport) {
  return {
    report_id: r.reportId,
    paper_title: r.paperTitle,
    mode: r.mode,
    gate: r.gate ? gateResultToDict(r.gate) : null,
    panels: r.panels.map(panelVerdictToDict),
    final_score: r.finalScore,
    passed: r.passed,
    vetoed: r.vetoed,
    veto_reasons: r.vetoReasons,
    fraud_findings: r.fraudFindings.map(fraudFindingToDict),
    revision_roadmap: r.revisionRoadmap,
    replay: r.replay.map(arbitrationLogToDict),
    usage_summary: r.usageSummary,
  }
}
