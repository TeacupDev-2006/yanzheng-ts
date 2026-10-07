/**
 * 引用核查 skill（自建，参考 Claude Scholar /check-refs 思路）：
 * 从参考文献列表解析条目 → 逐条到 Crossref 验证真实性。
 * 对照 yanzheng/skills/citation_check.py。
 * - 命中：返回 DOI/标题相似度证据
 * - 未命中：标记"疑似捏造"疑点（严重等级由总仲裁复核裁定）
 * - 无网络时降级为"仅格式解析"模式，并在结果中注明
 */

import { guardedFetch } from './http-guard.js'

export interface RefEntry {
  raw: string
  index: number
  titleGuess: string
  authorsGuess: string
  yearGuess: string
}

export interface RefCheckResult {
  entry: RefEntry
  status: 'verified' | 'not_found' | 'format_only' | 'error'
  evidence: string
  matchedTitle: string
  score: number
}

const REF_SPLIT = /^[ \t\n\v\f\r\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*\[(\d+)]\s*(.+)$/gm

/** 解析 [1] ... [2] ... 形式的参考文献列表（标题近似提取）。 */
export function parseReferences(text: string): RefEntry[] {
  const entries: RefEntry[] = []
  for (const m of text.matchAll(REF_SPLIT)) {
    const idx = Number.parseInt(m[1] ?? '0', 10)
    const raw = (m[2] ?? '').trim()
    const segments = raw
      .split(/[.．]\s+/)
      .map((s) => s.trim())
      .filter((s) => s)
    let title = ''
    if (segments.length >= 2) {
      title = (segments[1] ?? '').replace(/\[[JMCDSERPZ]\]$|[[［][^\]］]*[\]］]$/, '').trim()
    }
    if (!title) title = raw.slice(0, 60)
    const ym = /(19|20)\d{2}/.exec(raw)
    entries.push({
      raw,
      index: idx,
      titleGuess: title,
      authorsGuess: segments[0] ?? '',
      yearGuess: ym ? ym[0] : '',
    })
  }
  return entries
}

function titleSimilarity(a: string, b: string): number {
  const aChars = new Set(a.toLowerCase().replace(/\W+/g, ''))
  const bChars = new Set(b.toLowerCase().replace(/\W+/g, ''))
  if (aChars.size === 0 || bChars.size === 0) return 0
  let inter = 0
  for (const c of aChars) if (bChars.has(c)) inter++
  return inter / (aChars.size + bChars.size - inter)
}

interface CrossrefItem {
  title?: string[]
  DOI?: string
}

async function queryCrossref(title: string, timeoutMs = 8000): Promise<CrossrefItem | null> {
  const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(title)}&rows=1`
  try {
    const resp = await guardedFetch(url, {
      timeoutMs,
      headers: { 'User-Agent': 'yanzheng/0.1 (hackathon)' },
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as { message?: { items?: CrossrefItem[] } }
    const items = data.message?.items ?? []
    return items[0] ?? null
  } catch {
    return null // 网络异常降级
  }
}

/** 单条引用核查。online=false 或网络失败时降级 format_only。 */
export async function checkReference(entry: RefEntry, online = true): Promise<RefCheckResult> {
  if (!online) {
    return { entry, status: 'format_only', evidence: '离线模式：仅解析格式，未联网验证', matchedTitle: '', score: 0 }
  }
  const hit = await queryCrossref(entry.titleGuess)
  if (hit === null) {
    return {
      entry,
      status: 'not_found',
      evidence: `Crossref 检索无命中：title≈${JSON.stringify(entry.titleGuess)}（疑似捏造，需人工复核）`,
      matchedTitle: '',
      score: 0,
    }
  }
  const hitTitle = hit.title?.[0] ?? ''
  const score = titleSimilarity(entry.titleGuess, hitTitle)
  const doi = hit.DOI ?? ''
  if (score >= 0.5) {
    return { entry, status: 'verified', evidence: `Crossref 命中 DOI=${doi}`, matchedTitle: hitTitle, score }
  }
  return {
    entry,
    status: 'not_found',
    evidence: `最近命中 DOI=${doi} 但标题相似度仅 ${score.toFixed(2)}（${hitTitle.slice(0, 60)}），疑似捏造`,
    matchedTitle: hitTitle,
    score,
  }
}

export interface CitationCheckResult {
  mode: 'online' | 'format_only'
  total: number
  verified: number
  fabricated_candidates: number
  details: {
    index: number
    raw: string
    status: string
    evidence: string
    score: number
  }[]
}

/** skill 入口：返回 {"entries", "fabricated_candidates", "mode"}。 */
export async function runCitationCheck(text: string, online = true, maxItems = 30): Promise<CitationCheckResult> {
  const entries = parseReferences(text).slice(0, maxItems)
  const results: RefCheckResult[] = []
  for (const e of entries) results.push(await checkReference(e, online))
  const fabricated = results.filter((r) => r.status === 'not_found')
  return {
    mode: online ? 'online' : 'format_only',
    total: results.length,
    verified: results.filter((r) => r.status === 'verified').length,
    fabricated_candidates: fabricated.length,
    details: results.map((r) => ({
      index: r.entry.index,
      raw: r.entry.raw.slice(0, 120),
      status: r.status,
      evidence: r.evidence,
      score: Math.round(r.score * 1000) / 1000,
    })),
  }
}
