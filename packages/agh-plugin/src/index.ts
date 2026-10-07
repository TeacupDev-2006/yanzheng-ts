/**
 * 研证 · AGH 插件入口：注册确定性评卷工具链 + TS 原生全流程评卷。
 * 结构对照官方示例 examples/packages/hot-tool-plugin（TypeBox schema，工具语义见各 meta 声明）。
 *
 * 相对原 agh-thesis-review 的关键差异：thesis_review 不再 spawn Python 子进程，
 * 而是直接调用 @yanzheng/core 的 reviewPaper —— 引擎即插件，单一运行时。
 */

import { Type, type Static } from '@sinclair/typebox'
import {
  runGate,
  splitSections,
  duplicationRate,
  ngramSet,
  reviewPaper,
  renderHtml,
  exportPptx,
  loadCorpusDir,
  parsePdfText,
  demoMockLLM,
  type ReviewReport,
} from '@yanzheng/core'

// ---------------------------------------------------------------------------
// AGH 扩展 API 的结构化最小类型（运行时由 ctx.extension() 注入）
// ---------------------------------------------------------------------------

export interface AghLog {
  info(msg: string): void
  error(msg: string): void
}

export interface AghExtensionApi {
  registerTool(tool: {
    name: string
    description: string
    parameters: unknown
    meta: Record<string, unknown>
    execute(args: Record<string, unknown>): Promise<ToolResult>
  }): void
  on(event: 'session_start', handler: () => void): void
  ctx: { log: AghLog }
}

export interface ToolResult {
  content: { type: 'text'; text: string }[]
  structured?: unknown
}

export interface AghPluginContext {
  extension(): AghExtensionApi
}

// ---------------------------------------------------------------------------
// 参数 schema（TypeBox）
// ---------------------------------------------------------------------------

const TextParam = Type.String({ description: '论文全文文本' })
const CorpusItem = Type.Object(
  {
    name: Type.String(),
    text: Type.String(),
  },
  { additionalProperties: false },
)
const CorpusArray = Type.Array(CorpusItem)

const ReadOnlyMeta = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe',
  // AGH checkToolDef 要求两个键显式存在（"no cost hint" 写作 costHint: undefined，不可省略键）
  costHint: undefined,
  deferLoading: false,
  requiresApproval: 'never',
}

// ---------------------------------------------------------------------------
// 工具实现（与 AGH 无关的纯函数，便于单测）
// ---------------------------------------------------------------------------

export interface GateArgs extends Static<typeof GateParamsShape> {}
export const GateParamsShape = Type.Object(
  {
    text: TextParam,
    minWords: Type.Optional(Type.Number({ default: 10000 })),
    dupThreshold: Type.Optional(Type.Number({ default: 0.1 })),
    corpus: Type.Optional(CorpusArray),
  },
  { additionalProperties: false },
)

export async function executeGate(args: Record<string, unknown>): Promise<ToolResult> {
  const a = args as unknown as GateArgs
  const corpusDocs = (a.corpus ?? []).map((c) => c.text ?? '')
  const gate = runGate({
    text: a.text,
    minWords: a.minWords ?? 10000,
    dupThreshold: a.dupThreshold ?? 0.1,
    corpus: corpusDocs,
  })
  // 工具输出 snake_case，字段对照原 agh-thesis-review 的 thesis_gate
  return finish({
    passed: gate.passed,
    word_count: gate.wordCount,
    min_words: gate.minWords,
    duplication_rate: gate.duplicationRate,
    dup_threshold: gate.dupThreshold,
    format_issues: gate.formatIssues,
    warnings: gate.warnings,
  })
}

export interface SectionsArgs extends Static<typeof SectionsParamsShape> {}
export const SectionsParamsShape = Type.Object(
  {
    text: TextParam,
    bodyCap: Type.Optional(Type.Number({ default: 3000 })),
  },
  { additionalProperties: false },
)

export async function executeSections(args: Record<string, unknown>): Promise<ToolResult> {
  const a = args as unknown as SectionsArgs
  const bodyCap = a.bodyCap ?? 3000
  const sections = splitSections(a.text).map((s) => ({
    title: s.title,
    body_length: s.body.length,
    body: s.body.slice(0, bodyCap),
    truncated: s.body.length > bodyCap,
  }))
  return finish({ count: sections.length, sections })
}

export interface DedupArgs extends Static<typeof DedupParamsShape> {}
export const DedupParamsShape = Type.Object(
  {
    text: TextParam,
    corpus: CorpusArray,
    topK: Type.Optional(Type.Number({ default: 5 })),
  },
  { additionalProperties: false },
)

/** 分块查重取证：论文块 vs 语料块的最佳匹配（对照原 index.mjs thesis_dedup 逐行）。 */
export async function executeDedup(args: Record<string, unknown>): Promise<ToolResult> {
  const a = args as unknown as DedupArgs
  const docs = (a.corpus ?? []).map((c) => ({ name: c.name ?? 'unnamed', text: c.text ?? '' }))
  const matches: { paper_chunk_index: number; name: string; sim: number; excerpt: string }[] = []
  const size = 400
  const stripped = a.text.replace(/\s+/g, '')
  for (let i = 0; i + size <= stripped.length; i += 320) {
    const p = stripped.slice(i, i + size)
    let best = { name: '', sim: -1, excerpt: '' }
    for (const d of docs) {
      const sim = duplicationRate(p, [d.text])
      if (sim > best.sim) best = { name: d.name, sim, excerpt: d.text.replace(/\s+/g, '').slice(0, 120) }
    }
    if (best.sim > 0) matches.push({ paper_chunk_index: matches.length, ...best })
  }
  matches.sort((x, y) => y.sim - x.sim)
  return finish({
    rate: matches.length ? matches[0]!.sim : 0.0,
    matches: matches.slice(0, a.topK ?? 5),
  })
}

export interface ReviewArgs extends Static<typeof ReviewParamsShape> {}
export const ReviewParamsShape = Type.Object(
  {
    paperPath: Type.String({ description: '论文文件路径（.pdf/.txt/.md）' }),
    outPath: Type.String({ description: 'HTML 报告输出路径' }),
    minWords: Type.Optional(Type.Number({ default: 10000 })),
    corpusDir: Type.Optional(Type.String({ description: '查重语料库目录（可选）' })),
    online: Type.Optional(Type.Boolean({ default: false, description: '启用 Crossref/OpenAlex 在线核查' })),
    pptPath: Type.Optional(Type.String({ description: '同时导出 PPT 到指定路径（可选）' })),
    mock: Type.Optional(Type.Boolean({ default: false, description: '强制演示模式（确定性 mock，不调 LLM）' })),
  },
  { additionalProperties: false },
)

/** TS 原生全流程评卷：加载论文/语料 → reviewPaper → 写 HTML 报告（可选 PPT）。 */
export async function executeReview(args: Record<string, unknown>): Promise<ToolResult> {
  const a = args as unknown as ReviewArgs
  const text = /\.(txt|md)$/i.test(a.paperPath)
    ? await readFileText(a.paperPath)
    : await parsePdfText(a.paperPath)
  const corpus = a.corpusDir ? await loadCorpusDir(a.corpusDir) : {}
  const report: ReviewReport = await reviewPaper({
    text,
    title: basenameOf(a.paperPath),
    corpus,
    online: a.online ?? false,
    minWords: a.minWords ?? 10000,
    // mock=true 强制演示模式；否则按 YANZHENG_API_KEY 有无自动判定
    ...(a.mock ? { apiKey: null, mockFn: demoMockLLM } : {}),
  })
  await writeFileText(a.outPath, renderHtml(report))
  const result: Record<string, unknown> = {
    report_id: report.reportId,
    mode: report.mode,
    gate_passed: report.gate?.passed ?? false,
    word_count: report.gate?.wordCount ?? 0,
    duplication_rate: report.gate?.duplicationRate ?? 0,
    final_score: report.finalScore,
    passed: report.passed,
    vetoed: report.vetoed,
    veto_reasons: report.vetoReasons,
    panels: report.panels.map((v) => ({ panel: v.panelName, score: v.finalScore, max: v.maxScore })),
    fraud_findings: report.fraudFindings.length,
    revision_roadmap: report.revisionRoadmap.length,
    report_path: a.outPath,
    usage_summary: report.usageSummary,
  }
  if (a.pptPath) {
    result.ppt_path = await exportPptx(report, a.pptPath)
  }
  return finish(result)
}

// ---------------------------------------------------------------------------
// 插件出口
// ---------------------------------------------------------------------------

export const thesisReviewTools = {
  inject: ['extension'],
  apply(ctx: AghPluginContext) {
    const agnes = ctx.extension()

    // ① 硬性门检：字数/必备章节/警告项/分块查重（确定性，与 Python 金标逐字段等价）
    agnes.registerTool({
      name: 'thesis_gate',
      description:
        '毕业论文硬性门检：字数统计（中文1字/英文1词）、必备章节、警告项、与语料的分块查重率。' +
        '返回 passed 与全部明细；不通过即打回。',
      parameters: GateParamsShape,
      meta: ReadOnlyMeta,
      execute: executeGate,
    })

    // ② 章节切分：标题行识别 + 正文聚合
    agnes.registerTool({
      name: 'thesis_sections',
      description: '按中文论文章节标题（第X章/N.N/一、）切分文本，返回章节列表（正文超长截断）。',
      parameters: SectionsParamsShape,
      meta: ReadOnlyMeta,
      execute: executeSections,
    })

    // ③ 分块查重取证：论文块 vs 语料块的最佳匹配（供重复检测评卷员引用）
    agnes.registerTool({
      name: 'thesis_dedup',
      description: '分块查重取证：返回论文各块与语料库的最佳相似匹配（相似度+摘录），按相似度降序。',
      parameters: DedupParamsShape,
      meta: ReadOnlyMeta,
      execute: executeDedup,
    })

    // ④ TS 原生全流程评卷（4团13员+两级仲裁+作假否决），写报告文件
    agnes.registerTool({
      name: 'thesis_review',
      description:
        '运行研证 TS 引擎完整评卷（4团13员+两级仲裁+作假否决），生成单文件 HTML 报告（可选 PPT）。' +
        '写报告文件，执行前需批准；无 API key 时自动进入确定性 mock 演示模式。',
      parameters: ReviewParamsShape,
      meta: {
        isReadOnly: false,
        isDestructive: false,
        isConcurrencySafe: false,
        isOpenWorld: true,
        // 当前 AGH replay 合法值：safe | never | idempotent（写报告文件 → 不可自动重放）
        replay: 'never',
        // 全流程评卷（13 员 LLM 调用 + 报告生成）成本提示：预计 1-4 分钟墙钟
        costHint: { wallMs: 240000 },
        deferLoading: false,
        requiresApproval: 'always',
      },
      execute: executeReview,
    })

    agnes.on('session_start', () => {
      agnes.ctx.log.info(
        'yanzheng thesis-review tools ready: thesis_gate / thesis_sections / thesis_dedup / thesis_review',
      )
    })
  },
}

export default thesisReviewTools

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function finish(structured: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structured }
}

async function readFileText(p: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(p, 'utf-8')
}

async function writeFileText(p: string, data: string): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, data, 'utf-8')
}

function basenameOf(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  const name = i === -1 ? p : norm.slice(i + 1)
  return name.replace(/\.[^.]+$/, '')
}

// ngramSet 随 core 导出（供外部诊断复用）；此处引用以防 tree-shake 误删
void ngramSet
