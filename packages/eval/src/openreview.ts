/**
 * 实验①数据源：OpenReview 公开评审（v2 API）。
 * 拉取指定 venue 的"论文（标题+摘要）+ 官方评审评分"，构成"论文-人类评分"配对样本。
 * 注意边界：人类评分不是标准答案（跨年分布漂移、评审员间一致性有限），
 * 对照结论应表述为"分布/排名一致性"，而非"AI 评分被证明正确"。
 */

export interface OpenReviewSample {
  id: string
  title: string
  abstract: string
  /** 官方评审评分均值（原始量表，如 ICLR 1~10）；无有效评审则为 null */
  humanScore: number | null
  /** 评审文本（供报告里与研证扣分点并列定性对照） */
  reviewsText: string[]
}

export interface FetchOptions {
  venueId?: string
  limit?: number
  apiBase?: string
  /** 请求间隔毫秒（礼貌限速） */
  delayMs?: number
}

/** 解析 OpenReview rating 字符串（如 "6: marginally above the acceptance threshold" → 6）。 */
export function parseRating(raw: unknown): number | null {
  if (typeof raw === 'number') return raw
  if (typeof raw !== 'string') return null
  const m = raw.match(/^\s*(-?\d+(?:\.\d+)?)/)
  return m ? Number.parseFloat(m[1]!) : null
}

interface Note {
  id: string
  content: Record<string, { value?: unknown }>
}

async function getJson(url: string): Promise<{ notes?: Note[] } | null> {
  const resp = await fetch(url, { headers: { 'user-agent': 'yanzheng-eval/0.6' } })
  if (!resp.ok) return null
  return (await resp.json()) as { notes?: Note[] }
}

const val = (c: Note['content'], k: string): string => {
  const v = c[k]?.value
  return typeof v === 'string' ? v : ''
}

/** 拉取配对样本。失败的单篇跳过（评审缺失/摘要缺失），返回数量可能小于 limit。 */
export async function fetchOpenReviewSamples(opts: FetchOptions = {}): Promise<OpenReviewSample[]> {
  const venueId = opts.venueId ?? 'ICLR.cc/2023/Conference'
  const limit = opts.limit ?? 10
  const base = opts.apiBase ?? 'https://api2.openreview.net'
  const delayMs = opts.delayMs ?? 300
  const out: OpenReviewSample[] = []

  const subs = await getJson(
    `${base}/notes?content.venueid=${encodeURIComponent(venueId)}&limit=${Math.min(limit * 3, 100)}`,
  )
  for (const note of subs?.notes ?? []) {
    if (out.length >= limit) break
    const title = val(note.content, 'title')
    const abstract = val(note.content, 'abstract')
    if (!title || !abstract) continue
    await new Promise((d) => setTimeout(d, delayMs))
    const reviews = await getJson(
      `${base}/notes?forum=${note.id}&invitation=${encodeURIComponent(`${venueId}/-/Official_Review`)}&limit=50`,
    )
    const scores: number[] = []
    const texts: string[] = []
    for (const r of reviews?.notes ?? []) {
      const rating = parseRating(r.content.rating?.value)
      if (rating !== null) scores.push(rating)
      const reviewText = val(r.content, 'review') || val(r.content, 'summary')
      if (reviewText) texts.push(reviewText)
    }
    out.push({
      id: note.id,
      title,
      abstract,
      humanScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      reviewsText: texts.slice(0, 5),
    })
  }
  return out
}
