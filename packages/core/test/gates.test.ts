/** 门检单元测试（对照原 tests/test_core.py TestGates）。 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkFormat, countWords, duplicationRate, runGate } from '../src/gates/gates.js'

const DATA = fileURLToPath(new URL('../../../testdata/', import.meta.url))
const DEMO_PAPER = readFileSync(DATA + 'demo_paper.txt', 'utf-8')

describe('gates', () => {
  it('count_words：中文字符计 1，英文单词计 1', () => {
    expect(countWords('垃圾分类ABC')).toBe(5)
  })

  it('check_format：缺少结论被检出', () => {
    const text = '本文有摘要和绪论与参考文献，但缺少最终章节'
    const issues = checkFormat(text)
    expect(issues.some((i) => i.includes('结论'))).toBe(true)
  })

  it('check_format：别名命中即通过', () => {
    expect(checkFormat('摘要 绪论 总结与展望 参考文献')).toEqual([])
  })

  it('duplication：完全相同为 1', () => {
    const d = '这是一段完全重复的文本内容示例'
    expect(duplicationRate(d, [d])).toBe(1.0)
  })

  it('duplication：无关文本为低值', () => {
    const a = '校园垃圾分类系统的设计与实现'.repeat(20)
    const b = '量子计算在密码学中的应用研究综述'.repeat(20)
    expect(duplicationRate(a, [b])).toBeLessThan(0.05)
  })

  it('run_gate：字数不足打回', () => {
    const g = runGate({ text: '太短了', corpus: [], minWords: 10000 })
    expect(g.passed).toBe(false)
  })

  it('run_gate：查重超标打回', () => {
    const g = runGate({ text: DEMO_PAPER, corpus: [DEMO_PAPER], minWords: 10, dupThreshold: 0.1 })
    expect(g.passed).toBe(false)
    expect(g.duplicationRate).toBeGreaterThanOrEqual(0.1)
  })
})
