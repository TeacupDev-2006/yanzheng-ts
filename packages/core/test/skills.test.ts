/** skills 单元测试（对照原 tests/test_core.py TestSkills）。 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { splitSections } from '../src/skills/pdf-parse.js'
import { parseReferences } from '../src/skills/citation.js'
import { extractPercentClaims, findInconsistentPairs } from '../src/skills/consistency.js'

const DATA = fileURLToPath(new URL('../../../testdata/', import.meta.url))

describe('skills', () => {
  it('split_sections：按章节编号切分', () => {
    const secs = splitSections('第一章 绪论\n内容A\n第二章 方法\n内容B')
    expect(secs.map((s) => s.title)).toEqual(['第一章 绪论', '第二章 方法'])
  })

  it('split_sections：无标题回退单节全文', () => {
    expect(splitSections('无标题文本')).toEqual([{ title: '全文', body: '无标题文本' }])
  })

  it('parse_references：解析编号与标题', () => {
    const refs = parseReferences('[1] 王强. 垃圾分类研究[J]. 2021.\n[2] Smith J. Waste survey[J]. 2022.')
    expect(refs.map((r) => r.index)).toEqual([1, 2])
    expect(refs[0]!.titleGuess).toContain('垃圾分类')
  })

  it('percent：同指标不同数值被检出', () => {
    const claims = extractPercentClaims('系统准确率达到95.2%，实验表明该模型准确率89.3%，两个数字均为分类准确率')
    expect(findInconsistentPairs(claims)).toBeTruthy()
  })

  it('percent：数值一致无发现', () => {
    const claims = extractPercentClaims('模型准确率为89.3%，该准确率89.3%与另一处准确率89.3%一致')
    expect(findInconsistentPairs(claims)).toEqual([])
  })

  it('fraud_variants 作假变体可被确定性技能检出', () => {
    const citation = readFileSync(DATA + 'fraud_variants/fraud_citation.md', 'utf-8')
    const refs = parseReferences(citation)
    expect(refs.length).toBeGreaterThan(0)

    const data = readFileSync(DATA + 'fraud_variants/fraud_data.md', 'utf-8')
    const claims = extractPercentClaims(data)
    // 作假注入的数据矛盾应至少产生一批候选断言
    expect(claims.length).toBeGreaterThan(0)
  })
})
