/**
 * 文献检索 skill（轻量）：OpenAlex 检索论文主题相关工作，供选题/创新性评卷员对照。
 * 对照 yanzheng/skills/literature_search.py。在线模式走 OpenAlex API（无需 key）；
 * 离线/mock 模式返回基于标题关键词的占位说明。
 */

import { guardedFetch } from './http-guard.js'

const TITLE_STOP = /基于|面向|研究|设计|实现|分析|应用|探析|的|与|和|及|论/

/** 从标题+摘要前段抽取检索词（简单分词近似）。 */
export function extractKeywords(title: string, text: string, topN = 6): string[] {
  const candidates = (title || '').split(TITLE_STOP)
  const kws = candidates.map((c) => c.trim()).filter((c) => c && c.length >= 2)
  const head = text.slice(0, 600)
  for (const m of head.matchAll(/[\u4e00-\u9fff]{2,4}/g)) {
    if (!kws.includes(m[0]!) && kws.length < topN) kws.push(m[0]!)
  }
  return kws.slice(0, topN)
}

interface OpenAlexWork {
  title?: string
  publication_year?: number | null
  cited_by_count?: number
  doi?: string
}

export interface RelatedWork {
  title: string
  year: number | null
  cited_by: number
  doi: string
}

async function queryOpenAlex(query: string, timeoutMs = 8000): Promise<RelatedWork[]> {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=5`
  try {
    const resp = await guardedFetch(url, {
      timeoutMs,
      headers: { 'User-Agent': 'yanzheng/0.1 (hackathon)' },
    })
    if (!resp.ok) return []
    const data = (await resp.json()) as { results?: OpenAlexWork[] }
    return (data.results ?? []).map((w) => ({
      title: w.title ?? '',
      year: w.publication_year ?? null,
      cited_by: w.cited_by_count ?? 0,
      doi: w.doi ?? '',
    }))
  } catch {
    return [] // 网络异常降级
  }
}

export interface LiteratureReviewResult {
  mode: 'online' | 'offline'
  keywords: string[]
  query: string
  related_works: RelatedWork[]
  note: string
}

/** skill 入口：检索相关工作清单。online=false 时返回离线占位。 */
export async function runLiteratureReview(
  paperText: string,
  online = false,
  title = '',
): Promise<LiteratureReviewResult> {
  const lines = paperText.trim().split('\n')
  const guessTitle = title || (lines[0]?.trim() ?? '')
  const kws = extractKeywords(guessTitle, paperText)
  const query = kws.slice(0, 4).join(' ')
  const works = online ? await queryOpenAlex(query) : []
  return {
    mode: online ? 'online' : 'offline',
    keywords: kws,
    query,
    related_works: works,
    note: works.length ? '' : '离线模式：无检索结果，评卷员需按内部知识评估并降低confidence',
  }
}
