/**
 * 守护测试：runSkill 的导入路径必须解析到本包 skills（对照原 TestSkillWiring）。
 * 原项目曾因相对导入错误导致全部 skill 静默失败、评卷退化为纯 LLM——此测试防止回归。
 */

import { describe, expect, it } from 'vitest'
import { runSkill, type JudgeContext } from '../src/judges/base-judge.js'

const TEXT =
  '第一章 绪论\n本文研究垃圾分类，准确率 89.3%，摘要称 95.2%。\n[1] 王强. 垃圾分类研究[J]. 2021.'
const CTX: JudgeContext = { corpus: {}, online: false }

describe('skill wiring', () => {
  it('五个 skill 均可从评卷上下文装配（无 error）', async () => {
    for (const skill of ['pdf_parse', 'data_consistency', 'citation_check', 'literature_review', 'similarity_check']) {
      const res = await runSkill(skill, TEXT, CTX)
      expect('error' in res && res.error !== undefined, `skill ${skill} 装配失败: ${JSON.stringify(res)}`).toBe(false)
    }
  })

  it('未知 skill 报告 error', async () => {
    const res = await runSkill('no_such_skill', 'x', CTX)
    expect('error' in res).toBe(true)
  })

  it('pdf_parse 返回章节且标题以第一章开头', async () => {
    const res = await runSkill('pdf_parse', TEXT, CTX)
    const sections = res.sections as { title: string }[]
    expect(sections[0]!.title.startsWith('第一章')).toBe(true)
  })

  it('similarity_check 无语料时 abstain（评卷员应回避）', async () => {
    const res = await runSkill('similarity_check', TEXT, CTX)
    expect(res.abstain).toBe(true)
  })
})
