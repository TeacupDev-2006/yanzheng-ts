/**
 * 查重比对 skill（自建）：n-gram 指纹 + 可选嵌入余弦的混合相似度。
 * 对照 yanzheng/skills/similarity_check.py：
 * - 确定性层：字符 n-gram Jaccard（无需任何模型，可复现、可解释）
 * - 语义层（可选）：提供的嵌入函数存在时启用，捕获改写/翻译型抄袭
 * - 语料：用户自备目录（.txt/.md 直读，.pdf 走解析），公开源检索留作扩展
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PY_WS_STRIP } from './ws.js'
import { parsePdfText } from './pdf-parse.js'

export type EmbedFn = (s: string) => number[]

function grams(s: string, n: number): Set<string> {
  const t = s.replace(PY_WS_STRIP, '')
  const set = new Set<string>()
  for (let i = 0; i + n <= t.length; i++) set.add(t.slice(i, i + n))
  return set
}

export function ngramJaccard(a: string, b: string, n = 8): number {
  const ga = grams(a, n)
  const gb = grams(b, n)
  if (ga.size === 0 || gb.size === 0) return 0
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return inter / (ga.size + gb.size - inter)
}

export function cosine(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

export interface ChunkMatch {
  corpusDoc: string
  chunkIndex: number
  ngramSim: number
  embedSim: number | null
  combined: number
  excerpt: string
}

function chunk(text: string, size = 400, overlap = 80): string[] {
  const t = text.replace(PY_WS_STRIP, '')
  if (t.length <= size) return t ? [t] : []
  const steps = size - overlap
  const out: string[] = []
  for (let i = 0; i + size <= t.length; i += steps) out.push(t.slice(i, i + size))
  return out
}

function hashString(s: string): number {
  // 稳定字符串哈希（替代 Python hash()，仅用于嵌入缓存键分桶）
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return h
}

/** 论文分块 vs 语料分块的最相似匹配。返回 top_k 条证据。 */
export function hybridChunkMatch(
  queryText: string,
  corpus: Record<string, string>,
  embedFn: EmbedFn | null = null,
  n = 8,
  topK = 5,
  embedWeight = 0.5,
): ChunkMatch[] {
  const corpusChunks = new Map<string, string[]>(
    Object.entries(corpus).map(([doc, body]) => [doc, chunk(body)]),
  )
  const embedCache = new Map<string, number[]>()

  const emb = (s: string, key: string): number[] | null => {
    if (!embedFn) return null
    let v = embedCache.get(key)
    if (!v) {
      v = embedFn(s)
      embedCache.set(key, v)
    }
    return v
  }

  const matches: ChunkMatch[] = []
  const queryChunks = chunk(queryText)
  for (let qi = 0; qi < queryChunks.length; qi++) {
    const q = queryChunks[qi]!
    const qEmb = emb(q, `q:${qi}`)
    const bestPerDoc = new Map<string, ChunkMatch>()
    for (const [doc, chunks] of corpusChunks) {
      for (let ci = 0; ci < chunks.length; ci++) {
        const c = chunks[ci]!
        const ng = ngramJaccard(q, c, n)
        let em: number | null = null
        if (embedFn && qEmb) {
          const cEmb = emb(c, `c:${(hashString(doc) & 0xffff) * 10000 + ci}`)
          em = cEmb ? cosine(qEmb, cEmb) : null
        }
        const combined = em === null ? ng : (1 - embedWeight) * ng + embedWeight * em
        const cur: ChunkMatch = {
          corpusDoc: doc,
          chunkIndex: ci,
          ngramSim: ng,
          embedSim: em,
          combined,
          excerpt: c.slice(0, 120),
        }
        const best = bestPerDoc.get(doc)
        if (!best || combined > best.combined) bestPerDoc.set(doc, cur)
      }
    }
    matches.push(...bestPerDoc.values())
  }
  matches.sort((a, b) => b.combined - a.combined)
  return matches.slice(0, topK)
}

/** 加载自备语料库目录（.txt/.md 直接读；.pdf 走解析；单篇损坏不阻断整体）。 */
export async function loadCorpusDir(corpusDir: string): Promise<Record<string, string>> {
  const corpus: Record<string, string> = {}
  let entries: string[]
  try {
    entries = await readdir(corpusDir, { recursive: true })
  } catch {
    return corpus
  }
  for (const rel of entries) {
    const p = join(corpusDir, rel)
    if (/\.txt$/i.test(p) || /\.md$/i.test(p)) {
      corpus[basename(p)] = await readFile(p, 'utf-8')
    } else if (/\.pdf$/i.test(p)) {
      try {
        corpus[basename(p)] = await parsePdfText(p)
      } catch {
        continue
      }
    }
  }
  return corpus
}

function basename(p: string): string {
  const i = p.replace(/\\/g, '/').lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

export interface SimilarityMatchDict {
  corpus_doc: string
  chunk_index: number
  ngram_sim: number
  embed_sim: number | null
  combined: number
  excerpt: string
}

export interface SimilarityResult {
  abstain: boolean
  rate: number | null
  matches: SimilarityMatchDict[]
  note?: string
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}

/** skill 入口：返回 {"abstain", "rate", "matches"}。语料库为空时 abstain=true（无证据不打分）。 */
export function runSimilarityCheck(
  queryText: string,
  corpus: Record<string, string>,
  embedFn: EmbedFn | null = null,
): SimilarityResult {
  if (!corpus || Object.keys(corpus).length === 0) {
    return {
      abstain: true,
      rate: null,
      matches: [],
      note: '未提供查重语料库，重复率无法核验——评卷员应回避本项而非凭空给分',
    }
  }
  const matches = hybridChunkMatch(queryText, corpus, embedFn)
  const rate = matches.length ? Math.max(...matches.map((m) => m.combined)) : 0
  return {
    abstain: false,
    rate: round4(rate),
    matches: matches.map((m) => ({
      corpus_doc: m.corpusDoc,
      chunk_index: m.chunkIndex,
      ngram_sim: round4(m.ngramSim),
      embed_sim: m.embedSim === null ? null : round4(m.embedSim),
      combined: round4(m.combined),
      excerpt: m.excerpt,
    })),
  }
}
