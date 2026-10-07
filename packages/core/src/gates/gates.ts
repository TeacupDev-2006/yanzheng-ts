/**
 * 硬性门检：查重率、字数、格式完整性 —— 全部确定性程序计算，不靠 LLM。
 * 对照 yanzheng/core/gates.py 逐函数移植；等价性由 test/golden.test.ts
 * 以 Python 重算金标（testdata/golden.json）逐字段验证。
 * 注意所有正则与切片边界必须与 Python 严格一致（\s 语义、[:2500] 字符切片、^ 多行锚点）。
 */

import type { GateResult } from '../models.js'
import { PY_WS_CLASS } from '../skills/ws.js'

export const MIN_WORDS = 10000
export const DUP_THRESHOLD = 0.1
/** 必备章节（每项任一别名命中即算存在）—— 硬性项 */
export const REQUIRED_SECTIONS: readonly string[][] = [
  ['摘要', 'Abstract'],
  ['绪论', '引言', '研究背景'],
  ['结论', '总结', '结束语'],
  ['参考文献', 'References'],
]
/** 警告项：缺失不打回，但在报告中提示 */
export const MIN_REFS = 8
export const CHUNK = 400
export const CHUNK_STEP = 320

const PY_WS_ONE_OR_MORE = new RegExp(`[${PY_WS_CLASS}]+`, 'g')

/** 中文字符计 1 字，英文单词计 1 字（对照 gates.count_words）。 */
export function countWords(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const latin = (text.match(/[A-Za-z]+/g) ?? []).length
  return cjk + latin
}

/** 字符 n-gram 集合（对照 gates._grams，n=8；\s 全量剥除与 Python str 版一致）。 */
export function ngramSet(s: string, n = 8): Set<string> {
  const t = s.replace(PY_WS_ONE_OR_MORE, '')
  const set = new Set<string>()
  for (let i = 0; i + n <= t.length; i++) set.add(t.slice(i, i + n))
  return set
}

/** 字符 n-gram Jaccard 相似度（确定性、无需模型）。 */
export function ngramJaccard(a: string, b: string, n = 8): number {
  const ga = ngramSet(a, n)
  const gb = ngramSet(b, n)
  if (ga.size === 0 || gb.size === 0) return 0
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return inter / (ga.size + gb.size - inter)
}

/** 分块（400 字窗口、320 步长，对照 gates._chunk）。 */
export function chunk(text: string, size = CHUNK, step = CHUNK_STEP): string[] {
  const t = text.replace(PY_WS_ONE_OR_MORE, '')
  if (t.length <= size) return t ? [t] : []
  const out: string[] = []
  for (let i = 0; i + size <= t.length; i += step) out.push(t.slice(i, i + size))
  return out
}

/** 分块查重：论文块 vs 语料文档块的最大 n-gram Jaccard。能抓到"仅抄袭某一章"的局部重复。 */
export function duplicationRate(text: string, corpus: Iterable<string>, n = 8): number {
  if (!text.trim()) return 0
  const paperChunks = chunk(text)
  if (paperChunks.length === 0) return 0
  let worst = 0
  for (const doc of corpus) {
    for (const c of chunk(doc)) {
      for (const p of paperChunks) {
        const sim = ngramJaccard(p, c, n)
        if (sim > worst) {
          worst = sim
          if (worst >= 1) return worst
        }
      }
    }
  }
  return worst
}

/** 硬性格式检查：必备章节是否齐全（别名任一命中即可）。 */
export function checkFormat(text: string): string[] {
  const issues: string[] = []
  for (const alternates of REQUIRED_SECTIONS) {
    if (!alternates.some((sec) => text.includes(sec))) {
      issues.push(`缺少必备章节：${alternates.join('/')}`)
    }
  }
  return issues
}

/** 警告级检查：缺失不打回，报告提示。顺序与文案逐字对照 gates.check_warnings。 */
export function checkWarnings(text: string): string[] {
  const warns: string[] = []
  const head = text.slice(0, 2500)
  if (!head.includes('关键词') && !head.includes('Key words') && !head.includes('Keywords')) {
    warns.push('摘要后未见「关键词」标注')
  }
  if (!/\bAbstract\b/i.test(text)) {
    warns.push('未见英文摘要（Abstract）')
  }
  if (!text.slice(0, 3000).includes('目录')) {
    warns.push('未见目录页')
  }
  const idx = text.indexOf('参考文献')
  if (idx !== -1) {
    const refZone = text.slice(idx)
    const refLine = new RegExp(`^[${PY_WS_CLASS}]*\\[\\d+]`, 'gm')
    const refCount = (refZone.match(refLine) ?? []).length
    if (refCount < MIN_REFS) {
      warns.push(`参考文献仅 ${refCount} 条（建议 ≥${MIN_REFS} 条）`)
    }
  }
  return warns
}

export interface RunGateOptions {
  text: string
  corpus?: Iterable<string>
  minWords?: number
  dupThreshold?: number
}

/** 执行门检。硬性项任一不过即打回；警告项随报告提示。文本由调用方加载（txt/md 直读、pdf 走解析）。 */
export function runGate(opts: RunGateOptions): GateResult {
  const { text } = opts
  const minWords = opts.minWords ?? MIN_WORDS
  const dupThreshold = opts.dupThreshold ?? DUP_THRESHOLD
  const corpus = opts.corpus ?? []
  const words = countWords(text)
  const rate = duplicationRate(text, corpus)
  const fmt = checkFormat(text)
  const warns = checkWarnings(text)
  if (looksLikeScan(text)) {
    warns.push('抽取文本过短，疑似扫描件 PDF——请先 OCR 再提交')
  }
  const passed = words >= minWords && rate < dupThreshold && fmt.length === 0
  return {
    passed,
    wordCount: words,
    minWords,
    duplicationRate: rate,
    dupThreshold,
    formatIssues: fmt,
    warnings: warns,
  }
}

/** 扫描件识别：去空白后不足 200 字符（对照 pdf_parse.looks_like_scan，纯函数便于门检复用）。 */
export function looksLikeScan(text: string): boolean {
  return text.replace(PY_WS_ONE_OR_MORE, '').length < 200
}
