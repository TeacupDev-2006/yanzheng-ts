/**
 * 可控混淆语料生成器（实验②）：从真实文本构造"已知真值"的抄袭变体。
 * 这是 PAN@CLEF 基准的构造思路的轻量实现——每一级混淆都有明确 ground truth
 * （变体必然源自原文），因此可离线、可复现地量化查重的召回率。
 *
 * 等级：
 *   verbatim  逐字复制（最易）
 *   light     句序打乱
 *   medium    同义词替换 + 少量标点/连接词变化
 *   heavy     同义替换 + 句序打乱 + 随机删句 20%（最难）
 */

/** 确定性伪随机（LCG）：同 seed 同序列，保证实验可复现。 */
export function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

export type ObfuscateLevel = 'verbatim' | 'light' | 'medium' | 'heavy'

export const OBFUSCATE_LEVELS: readonly ObfuscateLevel[] = ['verbatim', 'light', 'medium', 'heavy']

/** 句子切分（保留终止标点）。 */
export function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[。！？；!?;])/)
  return parts.map((p) => p.trim()).filter(Boolean)
}

// 小型同义词表（中文，覆盖学术文本高频词；仅用于构造受控变体，不追求语言学完备）
const SYNONYMS: [string, string[]][] = [
  ['提高', ['提升', '增强', '改善']],
  ['降低', ['减少', '下降', '削减']],
  ['方法', ['途径', '手段', '方式']],
  ['使用', ['采用', '利用', '运用']],
  ['研究', ['探究', '考察', '分析']],
  ['结果', ['结论', '成果']],
  ['表明', ['说明', '指出', '显示']],
  ['显著', ['明显', '突出']],
  ['问题', ['难题', '议题']],
  ['设计', ['构建', '搭建']],
  ['实现', ['完成', '落地']],
  ['提出', ['给出', '引入']],
  ['性能', ['效能', '表现']],
  ['重要', ['关键', '主要']],
  ['不同', ['各异', '差别']],
]

function replaceSynonyms(text: string, rnd: () => number): string {
  let out = text
  for (const [word, subs] of SYNONYMS) {
    if (!out.includes(word)) continue
    out = out.split(word).join(subs[Math.floor(rnd() * subs.length)] ?? subs[0]!)
  }
  return out
}

function shuffle<T>(arr: T[], rnd: () => number): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

/** 按等级构造抄袭变体。 */
export function obfuscate(text: string, level: ObfuscateLevel, seed = 42): string {
  const rnd = lcg(seed)
  if (level === 'verbatim') return text
  let sentences = splitSentences(text)
  if (sentences.length === 0) return text

  if (level === 'light') {
    return shuffle(sentences, rnd).join('')
  }
  if (level === 'medium') {
    return sentences.map((s) => replaceSynonyms(s, rnd)).join('')
  }
  // heavy：同义替换 + 句序打乱 + 删句 20%（至少保留 1 句）
  const dropped = sentences.map((s) => replaceSynonyms(s, rnd))
  const keepCount = Math.max(1, Math.floor(dropped.length * 0.8))
  const kept = shuffle(dropped, rnd).slice(0, keepCount)
  return kept.join('')
}
