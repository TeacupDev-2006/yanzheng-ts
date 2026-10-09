/**
 * 主控引擎：门检 → 4 团 13 员并行评卷 → 团内仲裁 → 总仲裁 → 报告。
 * 对照 yanzheng/core/engine.py。对应竞赛闭环：任务规划（编排本流水线）、
 * 工具调用（评卷员 skills）、执行反馈（评分表回传+低置信度标记）、
 * 结果验证（多评互检+分差仲裁+确定性指标）、异常处理（降级/重试/打回）。
 */

import { LLMClient, type MockFn } from './llm/client.js'
import { runGate } from './gates/gates.js'
import { panelArbitration, chiefArbitration } from './arbiter.js'
import { ALL_PANELS, normalizePanels, type JudgeSpec, type PanelSpec } from './rubric.js'
import { BaseJudge, runSkill, type JudgeContext } from './judges/base-judge.js'
import type { RetractionRecord } from './skills/citation.js'
import {
  createReviewReport,
  newArbitrationLog,
  parseFraudType,
  parseSeverity,
  type FraudFinding,
  type ReviewReport,
  type ScoreSheet,
} from './models.js'

/** 评卷员以团满分为其满分（评的是整个维度），仲裁时合成维度分。 */
function fullScoreFor(panel: PanelSpec): number {
  return panel.maxScore
}

/** 限并发 map（保持提交顺序，对应 Python ThreadPoolExecutor(max_workers=13)）。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i]!, i)
    }
  })
  await Promise.all(workers)
  return results
}

export interface ReviewOptions {
  /** 论文全文文本（调用方负责加载：txt/md 直读、pdf 走解析） */
  text: string
  title?: string
  corpus?: Record<string, string> | null
  online?: boolean
  apiKey?: string | null
  mockFn?: MockFn | null
  minWords?: number
  dupThreshold?: number
  /** 覆盖 LLM 端点/模型（缺省读 YANZHENG_LLM_BASE_URL 等环境变量） */
  baseUrl?: string
  modelFlash?: string
  modelPro?: string
  /** 思考开关请求体风格：'deepseek'（默认，DeepSeek V4 语义）| 'off'（第三方端点不携带） */
  thinkingStyle?: 'deepseek' | 'off'
  /** 可选：Retraction Watch 撤稿索引，传入后引用核查自动标记已撤稿文献 */
  retractions?: Map<string, RetractionRecord>
  /** 自定义评审团编制（缺省为标准 4 团 13 员）；经 normalizePanels 校验 */
  panels?: PanelSpec[]
  /** 消融开关：每团只取前 N 名评卷员（null=全部） */
  judgesLimit?: number | null
  /** 消融开关：False 时跳过两级仲裁，直接均值合成 */
  arbitrationEnabled?: boolean
}

/** 完整评卷流水线。mock 模式：无 api_key 或显式传入 mockFn 时启用。 */
export async function reviewPaper(opts: ReviewOptions): Promise<ReviewReport> {
  const t0 = Date.now()
  const client = new LLMClient({
    apiKey: opts.apiKey,
    mockFn: opts.mockFn ?? undefined,
    baseUrl: opts.baseUrl,
    modelFlash: opts.modelFlash,
    modelPro: opts.modelPro,
    thinkingStyle: opts.thinkingStyle,
  })
  const mode: 'mock' | 'real' = client.mock ? 'mock' : 'real'
  const report = createReviewReport(opts.title ?? '', mode)
  const corpus = opts.corpus ?? {}

  // ---------- 1. 硬性门检（确定性，不过打回） ----------
  const gate = runGate({
    text: opts.text,
    corpus: Object.values(corpus),
    minWords: opts.minWords,
    dupThreshold: opts.dupThreshold,
  })
  report.gate = gate
  if (!gate.passed) return report // 打回：不进入评卷环节，报告仅含门检结果

  const fullText = opts.text

  // ---------- 2. 各团并行、团内评卷员并行（互相不可见） ----------
  const context: JudgeContext = {
    corpus,
    online: opts.online ?? false,
    retractions: opts.retractions,
  }
  const panels = normalizePanels(opts.panels ?? ALL_PANELS)
  let judgeItems: { panel: PanelSpec; spec: JudgeSpec }[] = []
  const judgesLimit = opts.judgesLimit ?? null
  if (judgesLimit !== null && judgesLimit !== undefined) {
    for (const panel of panels) {
      for (let i = 0; i < Math.min(judgesLimit, panel.judges.length); i++) {
        judgeItems.push({ panel, spec: panel.judges[i]! })
      }
    }
  } else {
    for (const panel of panels) {
      for (const spec of panel.judges) judgeItems.push({ panel, spec })
    }
  }
  // 校准：无语料时依赖查重 skill 的评卷员回避（无证据不打分，防止满分离群）
  const abstained: { panel: PanelSpec; name: string }[] = []
  if (Object.keys(corpus).length === 0) {
    const keep: typeof judgeItems = []
    for (const item of judgeItems) {
      if (item.spec.skills.includes('similarity_check')) {
        abstained.push({ panel: item.panel, name: item.spec.name })
      } else {
        keep.push(item)
      }
    }
    judgeItems = keep
  }
  const judges = judgeItems.map(({ panel, spec }) => ({ panel, judge: new BaseJudge(spec, client) }))

  const sheetsByPanel = new Map<string, ScoreSheet[]>(panels.map((p) => [p.panelId, []]))
  const results = await mapWithConcurrency(judges, 13, ({ panel, judge }) =>
    judge.review(fullText, fullScoreFor(panel), context).then((sheet) => ({ panel, sheet })),
  )
  for (const { panel, sheet } of results) {
    sheetsByPanel.get(panel.panelId)!.push(sheet)
  }

  // 汇总作假发现（作假审查评卷员 raw_response 里由 LLM 输出，base_judge 暂存）
  const fraudFindings = collectFraud(sheetsByPanel)

  // ---------- 3. 团内仲裁（分差超阈值 → 团长复核）；无仲裁消融时直接均值 ----------
  const panelVerdicts = []
  for (const panel of panels) {
    const sheets = sheetsByPanel.get(panel.panelId) ?? []
    if (opts.arbitrationEnabled ?? true) {
      panelVerdicts.push(await panelArbitration(panel, sheets, client))
    } else {
      const mean = sheets.length ? round1(sheets.reduce((a, s) => a + s.score, 0) / sheets.length) : 0
      panelVerdicts.push({
        panel: panel.panelId,
        panelName: panel.name,
        finalScore: mean,
        maxScore: panel.maxScore,
        sheets,
        arbitration: [
          newArbitrationLog('panel', '消融开关', 'arb_disabled', '无仲裁消融：直接取均值'),
        ],
      })
    }
  }
  report.panels = panelVerdicts

  // 回避记录写入对应团的仲裁日志（可回放）
  if (abstained.length) {
    const byPanel = new Map<string, string[]>()
    for (const { panel, name } of abstained) {
      const names = byPanel.get(panel.panelId) ?? []
      names.push(name)
      byPanel.set(panel.panelId, names)
    }
    for (const v of report.panels) {
      for (const name of byPanel.get(v.panel) ?? []) {
        v.arbitration.push(
          newArbitrationLog('panel', '评卷调度', 'abstain', `${name} 因查重语料缺失回避本项评分（无证据不打分）`),
        )
      }
    }
    report.replay = panelVerdicts.flatMap((v) => v.arbitration)
  }

  // ---------- 4. 总仲裁（合成 + 作假否决 + 路线图） ----------
  const allSheets = [...sheetsByPanel.values()].flat()
  if (opts.arbitrationEnabled ?? true) {
    const chief = await chiefArbitration(panelVerdicts, allSheets, fraudFindings, client, opts.title ?? '')
    report.finalScore = chief.finalScore
    report.passed = chief.passed
    report.vetoed = chief.vetoed
    report.vetoReasons = chief.vetoReasons
    report.revisionRoadmap = chief.revisionRoadmap
    report.replay = [...panelVerdicts.flatMap((v) => v.arbitration), ...chief.replay]
  } else {
    const total = round1(panelVerdicts.reduce((acc, v) => acc + v.finalScore, 0))
    report.finalScore = total
    // 无复核时保守：有作假疑点即不通过
    report.passed = total >= 60 && fraudFindings.length === 0
    report.revisionRoadmap = naiveRoadmap(allSheets, fraudFindings)
    report.replay = [
      ...panelVerdicts.flatMap((v) => v.arbitration),
      newArbitrationLog('chief', '消融开关', 'arb_disabled', '无仲裁消融：跳过总仲裁复核'),
    ]
  }
  report.fraudFindings = fraudFindings
  report.usageSummary = {
    elapsed_seconds: Math.round((Date.now() - t0) / 100) / 10,
    models: client.usageSummary(),
    config: {
      judges_limit: judgesLimit,
      arbitration_enabled: opts.arbitrationEnabled ?? true,
      panels: panels.length,
      judges: allSheets.length,
    },
  }
  return report
}

/** 无仲裁消融的朴素路线图：扣分点直接排序去重。 */
function naiveRoadmap(
  allSheets: ScoreSheet[],
  fraudFindings: FraudFinding[],
): { priority: number; severity: string; issue: string; action: string; location: string }[] {
  const seen = new Set<string>()
  const roadmap: { priority: number; severity: string; issue: string; action: string; location: string }[] = []
  const sorted = allSheets.flatMap((s) => s.deductions).sort(
    (a, b) => sevRank(a.severity) - sevRank(b.severity),
  )
  for (const d of sorted) {
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
  void fraudFindings // 与 chief 路线图不同：消融模式不含作假专区条目，保持原实现
  return roadmap.slice(0, 25)
}

const SEV_RANK: Record<string, number> = { 严重: 0, 较重: 1, 轻微: 2 }
function sevRank(s: string): number {
  return SEV_RANK[s] ?? 3
}

/** 从评卷员评分表的 raw_response（fraud_findings JSON）汇总作假疑点。
 *  任何评卷员（含自定义编制的）输出的有证据疑点都进入汇总；只有"严重"级会进入否决复核。 */
function collectFraud(sheetsByPanel: Map<string, ScoreSheet[]>): FraudFinding[] {
  const findings: FraudFinding[] = []
  for (const sheets of sheetsByPanel.values()) {
    for (const s of sheets) {
      let data: unknown
      try {
        data = s.rawResponse ? JSON.parse(s.rawResponse) : []
      } catch {
        continue
      }
      if (!Array.isArray(data)) continue
      for (const item of data) {
        const it = item as Record<string, unknown>
        const severity = parseSeverity(it.severity ?? '较重')
        if (!severity) continue
        findings.push({
          fraudType: parseFraudType(it.fraud_type ?? '数据不一致'),
          location: String(it.location ?? ''),
          evidence: String(it.evidence ?? ''),
          severity,
          suggestion: '提交总仲裁复核证据链',
        })
      }
    }
  }
  return findings
}

function round1(x: number): number {
  return Math.round(x * 10) / 10
}

// runSkill 供外部（AGH 插件诊断等）复用
export { runSkill }
