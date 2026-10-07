/**
 * 金标等价性测试：TS 门检实现 vs 原 Python 实现（scripts/gen_golden.py 重算）。
 * 任一字段不一致即失败 —— 这是对"逐函数移植正确性"的硬约束。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkFormat, checkWarnings, countWords, duplicationRate } from '../src/gates/gates.js'

const DATA = fileURLToPath(new URL('../../../testdata/', import.meta.url))

function read(p: string): string {
  return readFileSync(DATA + p, 'utf-8')
}

const GOLDEN = JSON.parse(read('golden.json')) as {
  corpus_names: string[]
  cases: Record<
    string,
    { word_count: number; format_issues: string[]; warnings: string[]; dup_rate_vs_corpus: number }
  >
}

function buildInputs(): Record<string, string> {
  const corpus1 = read('corpus/source1.txt')
  const corpus2 = read('corpus/source2.txt')
  return {
    demo: read('demo_paper.txt'),
    good: read('paper_good.md'),
    poor: read('paper_poor.md'),
    // 与 scripts/gen_golden.py 相同的 dupcase 构造规则
    dupcase: corpus1 + '\n扩展：本研究补充三组对照实验以验证方法的稳健性。\n',
  }
}

describe('golden equivalence vs Python', () => {
  const inputs = buildInputs()
  const corpusDocs = [read('corpus/source1.txt'), read('corpus/source2.txt')]

  for (const [name, expected] of Object.entries(GOLDEN.cases)) {
    it(`case ${name} 与 Python 金标逐字段一致`, () => {
      const text = inputs[name]!
      expect(countWords(text)).toBe(expected.word_count)
      expect(checkFormat(text)).toEqual(expected.format_issues)
      expect(checkWarnings(text)).toEqual(expected.warnings)
      const rate = duplicationRate(text, corpusDocs)
      // Python 端为整数计数相除，IEEE 语义下应逐位一致
      expect(rate).toBe(expected.dup_rate_vs_corpus)
    })
  }

  it('语料名单一致', () => {
    expect(GOLDEN.corpus_names).toEqual(['source1.txt', 'source2.txt'])
  })

  it('原 agh-thesis-review 金标中的 demo/good 字数复现（历史对照）', () => {
    // 原项目 python_gate.json：demo=1267, good=10074
    expect(GOLDEN.cases.demo!.word_count).toBe(1267)
    expect(GOLDEN.cases.good!.word_count).toBe(10074)
  })
})
