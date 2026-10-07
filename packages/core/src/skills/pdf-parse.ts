/**
 * PDF 解析 skill：文本抽取 + 按章节切分。
 * 对照 yanzheng/skills/pdf_parse.py。抽取链单库化：unpdf（pdf.js 的 Node 无 worker 封装）
 * 替代原 pdfplumber→pypdf→pdfminer 降级链。扫描件抽不出文字时由门检以字数不足打回。
 */

import { readFile } from 'node:fs/promises'
import { extractText, getDocumentProxy } from 'unpdf'
import { PY_WS_STRIP } from './ws.js'

const MIN_SENSIBLE_TEXT = 200 // 抽出的文本少于此长度视为"疑似扫描件/抽取失败"

/** 抽取 PDF 全文文本。.txt/.md 直读。 */
export async function parsePdfText(pdfPath: string): Promise<string> {
  if (/\.txt$/i.test(pdfPath) || /\.md$/i.test(pdfPath)) {
    return readFile(pdfPath, 'utf-8')
  }
  try {
    const buf = await readFile(pdfPath)
    const pdf = await getDocumentProxy(new Uint8Array(buf))
    const { text } = await extractText(pdf, { mergePages: true })
    const t = (Array.isArray(text) ? text.join('\n') : text) ?? ''
    if (t.trim()) return t
  } catch (exc) {
    throw new Error(`PDF 文本抽取失败（疑似扫描件或损坏）: ${pdfPath}；错误: ${String(exc)}`)
  }
  throw new Error(`PDF 文本抽取失败（疑似扫描件或损坏）: ${pdfPath}`)
}

/** 抽取文本过短 → 疑似扫描件，需要 OCR。 */
export function looksLikeScan(text: string): boolean {
  return text.replace(PY_WS_STRIP, '').length < MIN_SENSIBLE_TEXT
}

// 章节标题行：第X章 / N.N / 一、
const SECTION_PAT =
  /^(第[一二三四五六七八九十]+章|\d+(?:\.\d+)*|[一二三四五六七八九十]+、)\s*(.+)$/
const MAX_HEADING_LEN = 30 // 章节标题行不会太长；PDF 抽取的正文折行常以数字开头，须排除

export interface PaperSection {
  title: string
  body: string
}

/** 按常见中文论文章节标题切分。仅把"以章节编号开头且整行较短"的行视为标题。无命中时返回单节全文。 */
export function splitSections(text: string): PaperSection[] {
  const lines = text.split('\n')
  const headingIdx: { index: number; title: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    let s = (lines[i] ?? '').trim().replace(/^#+/, '').trim() // 兼容 markdown 来源的标题行
    if (!s || s.length > MAX_HEADING_LEN || s.includes('…')) continue
    const m = SECTION_PAT.exec(s)
    if (m && /[\u4e00-\u9fff]/.test(m[2] ?? '')) {
      // 标题须含中文，排除文献页码行
      s = `${m[1]} ${m[2]}`.trim()
      headingIdx.push({ index: i, title: s })
    }
  }

  if (headingIdx.length === 0) {
    return [{ title: '全文', body: text.trim() }]
  }

  const sections: PaperSection[] = []
  const first = headingIdx[0]!.index
  const head = lines.slice(0, first).join('\n').trim()
  if (head) sections.push({ title: '前言部分', body: head })
  for (let k = 0; k < headingIdx.length; k++) {
    const { index: i, title } = headingIdx[k]!
    const end = k + 1 < headingIdx.length ? headingIdx[k + 1]!.index : lines.length
    const body = lines.slice(i, end).join('\n').trim()
    sections.push({ title, body })
  }
  return sections
}

export interface LoadPaperResult {
  text: string
  sections: PaperSection[]
  isScan: boolean
}

export async function loadPaper(pdfPath: string): Promise<LoadPaperResult> {
  const text = await parsePdfText(pdfPath)
  return { text, sections: splitSections(text), isScan: looksLikeScan(text) }
}
