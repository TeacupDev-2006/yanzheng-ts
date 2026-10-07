/**
 * PPT 导出（pptxgenjs）：评卷结果 → 演示文稿。
 * 对照 yanzheng/reports/ppt_export.py（python-pptx 版）。
 * 页序：封面 → 总评 → 扣分明细（Top）→ 作假裁定（如有）→ 修改路线图。16:9 版式。
 *
 * 类型说明：pptxgenjs 4 的 .d.ts 将 default 导出与 UMD 命名空间合并声明，
 * TS 5.9 下默认导入不可构造（TS2351）；故此处以结构化最小接口约束类型，
 * 运行时 ESM 构建导出的是正常类。
 */

import PptxGenJSModule from 'pptxgenjs'
import { gradeOf } from '../rubric.js'
import type { ReviewReport } from '../models.js'

const FONT = 'Microsoft YaHei'
const ACCENT = '1F4E79'
const WARN = 'B91C1C'
const GREEN = '16A34A'
const RED = 'DC2626'
const GRAY = '6B7280'

interface SlideLike {
  addText(text: string, opts: Record<string, unknown>): unknown
  addTable(rows: unknown[], opts: Record<string, unknown>): unknown
}

interface PptxLike {
  defineLayout(layout: { name: string; width: number; height: number }): void
  layout: string
  addSlide(): SlideLike
  writeFile(opts: { fileName: string }): Promise<string>
}

const PptxGenJSCtor = PptxGenJSModule as unknown as new () => PptxLike

interface TextOpts {
  x: number
  y: number
  w: number
  h: number
  size: number
  bold?: boolean
  color?: string
}

function putText(slide: SlideLike, { x, y, w, h, size, bold = false, color }: TextOpts, text: string) {
  slide.addText(text, {
    x,
    y,
    w,
    h,
    fontSize: size,
    bold,
    color: color ?? '000000',
    fontFace: FONT,
    valign: 'top',
  })
}

interface TableSpec {
  x: number
  y: number
  w: number
  h: number
  headers: string[]
  rows: string[][]
  colWidths: number[]
}

function putTable(slide: SlideLike, { x, y, w, h, headers, rows, colWidths }: TableSpec) {
  const headerRow = headers.map((t) => ({ text: t, options: { bold: true, fontSize: 12, fontFace: FONT } }))
  const bodyRows = rows.map((row) => row.map((cell) => ({ text: cell, options: { fontSize: 10.5, fontFace: FONT } })))
  slide.addTable([headerRow, ...bodyRows], {
    x,
    y,
    w,
    h,
    colW: colWidths,
    border: { type: 'solid', color: 'D9D2C2', pt: 0.5 },
  })
}

/** 评卷结果 → .pptx 文件，返回输出路径。 */
export async function exportPptx(report: ReviewReport, outPath: string): Promise<string> {
  const pptx = new PptxGenJSCtor()
  pptx.defineLayout({ name: 'YANZHENG_16x9', width: 13.333, height: 7.5 })
  pptx.layout = 'YANZHENG_16x9'
  const title = report.paperTitle || '论文评卷报告'
  const totalMax = report.panels.reduce((acc, v) => acc + v.maxScore, 0)

  // 1. 封面
  let s = pptx.addSlide()
  putText(s, { x: 1, y: 2.2, w: 11.3, h: 1.2, size: 36, bold: true, color: ACCENT }, '研证 · 毕业论文评卷团报告')
  putText(s, { x: 1, y: 3.6, w: 11.3, h: 0.6, size: 20 }, title)
  putText(
    s,
    { x: 1, y: 4.4, w: 11.3, h: 0.5, size: 12, color: GRAY },
    `模拟高考评卷机制：4 团 13 员独立打分 → 分差仲裁 → 总合成（mode=${report.mode}）`,
  )

  // 2. 总评
  s = pptx.addSlide()
  const verdictColor = report.vetoed ? WARN : report.passed ? GREEN : RED
  const verdictText = report.vetoed ? '一票否决（作假成立）' : report.passed ? '通过' : '未通过'
  putText(s, { x: 0.8, y: 0.5, w: 11.7, h: 0.8, size: 28, bold: true, color: ACCENT }, '总评')
  putText(
    s,
    { x: 0.8, y: 1.8, w: 5.5, h: 2.2, size: 44, bold: true, color: verdictColor },
    `${report.finalScore}\n${gradeOf(report.finalScore, totalMax)} · ${verdictText}`,
  )
  const panelRows = report.panels.map((v) => [v.panelName, `${v.finalScore}`, `${v.maxScore}`])
  putTable(
    s,
    { x: 6.8, y: 1.6, w: 5.7, h: 3.0, headers: ['评审团', '得分', '满分'], rows: panelRows, colWidths: [2.7, 1.5, 1.5] },
  )

  // 3. 扣分明细（按严重度取前 12 条）
  s = pptx.addSlide()
  putText(s, { x: 0.8, y: 0.5, w: 11.7, h: 0.8, size: 28, bold: true, color: ACCENT }, '扣分明细（Top）')
  const sevOrder: Record<string, number> = { 严重: 0, 较重: 1, 轻微: 2 }
  const ded = report.panels
    .flatMap((v) => v.sheets.flatMap((sh) => sh.deductions))
    .sort((a, b) => (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3))
  const dedRows = ded.slice(0, 12).map((d) => [d.severity, d.location.slice(0, 18), d.description.slice(0, 40), d.suggestion.slice(0, 40)])
  putTable(
    s,
    {
      x: 0.8,
      y: 1.5,
      w: 11.7,
      h: 5.2,
      headers: ['等级', '定位', '问题描述', '修改建议'],
      rows: dedRows,
      colWidths: [1.0, 2.0, 4.3, 4.4],
    },
  )

  // 4. 作假裁定（如有）
  if (report.fraudFindings.length) {
    s = pptx.addSlide()
    putText(s, { x: 0.8, y: 0.5, w: 11.7, h: 0.8, size: 28, bold: true, color: WARN }, '作假审查专区')
    const fraudRows = report.fraudFindings.map((f) => [f.fraudType, f.location.slice(0, 20), f.evidence.slice(0, 44), f.severity])
    putTable(
      s,
      { x: 0.8, y: 1.5, w: 11.7, h: 3.6, headers: ['类型', '定位', '证据', '严重度'], rows: fraudRows, colWidths: [1.8, 2.2, 6.2, 1.5] },
    )
    if (report.vetoed) {
      putText(
        s,
        { x: 0.8, y: 5.4, w: 11.7, h: 1.4, size: 14, bold: true, color: WARN },
        '✘ 总仲裁裁定：一票否决\n' + report.vetoReasons.slice(0, 3).join('\n'),
      )
    }
  }

  // 5. 修改路线图
  s = pptx.addSlide()
  putText(s, { x: 0.8, y: 0.5, w: 11.7, h: 0.8, size: 28, bold: true, color: ACCENT }, '修改优先级路线图（Top 10）')
  const roadRows = report.revisionRoadmap.slice(0, 10).map((r) => [
    String(r.priority ?? ''),
    String(r.severity ?? ''),
    String(r.issue ?? '').slice(0, 40),
    String(r.action ?? '').slice(0, 40),
  ])
  putTable(
    s,
    {
      x: 0.8,
      y: 1.5,
      w: 11.7,
      h: 5.2,
      headers: ['#', '等级', '问题', '修改动作'],
      rows: roadRows,
      colWidths: [0.6, 1.0, 5.0, 5.1],
    },
  )

  await pptx.writeFile({ fileName: outPath })
  return outPath
}
