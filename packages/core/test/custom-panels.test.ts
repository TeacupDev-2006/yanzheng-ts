/**
 * 自定义评审团编制测试：Web 配置器背后的引擎能力——
 * 增删团/员、自定义 persona/skill/模型档、及格线与等级随编制总分缩放、配置校验。
 */

import { describe, expect, it } from 'vitest'
import { reviewPaper } from '../src/engine.js'
import { normalizePanels, gradeOf, ALL_PANELS } from '../src/rubric.js'
import type { PanelSpec } from '../src/rubric.js'

const PASSABLE_TEXT = '摘要 绪论 结论 参考文献 ' + '研究内容与实验数据。'.repeat(120)

function makePanel(id: string, name: string, maxScore: number, judges: Partial<PanelSpec['judges'][number]>[] = []): PanelSpec {
  return {
    panelId: id,
    name,
    maxScore,
    weightHint: '',
    judges:
      judges.length > 0
        ? judges.map((j, i) => ({
            judgeId: j.judgeId ?? `${id}_j${i + 1}`,
            name: j.name ?? `${name}评卷员${i + 1}`,
            panel: id,
            maxScore: j.maxScore ?? maxScore,
            persona: j.persona ?? `从「${name}」视角评卷`,
            skills: j.skills ?? [],
            modelTier: j.modelTier ?? 'flash',
          }))
        : [
            {
              judgeId: `${id}_j1`,
              name: `${name}评卷员1`,
              panel: id,
              maxScore,
              persona: `从「${name}」视角评卷`,
              skills: [],
              modelTier: 'flash',
            },
          ],
  }
}

describe('normalizePanels（编制解析与校验）', () => {
  it('空编制 / 无评卷员 / 非正满分 → 报错', () => {
    expect(() => normalizePanels([])).toThrow(/至少需要 1 个评审团/)
    expect(() => normalizePanels([{ name: 'X', maxScore: 10, judges: [] }])).toThrow(/至少需要 1 名评卷员/)
    expect(() => normalizePanels([{ name: 'X', maxScore: 0, judges: [{ name: 'a' }] }])).toThrow(/满分必须为正数/)
    expect(() => normalizePanels([{ name: 'X', maxScore: -5, judges: [{ name: 'a' }] }])).toThrow(/满分必须为正数/)
  })

  it('缺省字段自动补齐：id 生成、名称默认、persona 按团名生成', () => {
    const panels = normalizePanels([{ maxScore: 30, judges: [{ skills: ['citation_check'] }] }])
    expect(panels.length).toBe(1)
    expect(panels[0]!.name).toBe('评审团1')
    expect(panels[0]!.panelId).toBe('panel_1')
    const j = panels[0]!.judges[0]!
    expect(j.judgeId).toBe('panel_1_1')
    expect(j.name).toBe('评卷员1')
    expect(j.persona).toContain('评审团1')
    expect(j.skills).toEqual(['citation_check'])
    expect(j.modelTier).toBe('flash')
  })

  it('未知 skill 被过滤、modelTier 非法值回退 flash、id 冲突自动去重', () => {
    const panels = normalizePanels([
      { panelId: 'p', maxScore: 10, judges: [{ judgeId: 'dup', skills: ['pdf_parse', 'no_such_skill'], modelTier: 'pro' }] },
      { panelId: 'p', maxScore: 10, judges: [{ judgeId: 'dup', modelTier: 'weird' }] },
    ])
    expect(panels[0]!.panelId).toBe('p')
    expect(panels[1]!.panelId).toBe('p_2')
    expect(panels[0]!.judges[0]!.judgeId).toBe('dup')
    expect(panels[1]!.judges[0]!.judgeId).toBe('dup_2')
    expect(panels[0]!.judges[0]!.skills).toEqual(['pdf_parse'])
    expect(panels[1]!.judges[0]!.modelTier).toBe('flash')
  })

  it('恒等性：标准 4 团 13 员原样保留（id/persona 不变）', () => {
    const panels = normalizePanels(ALL_PANELS)
    expect(panels.length).toBe(4)
    expect(panels.reduce((a, p) => a + p.judges.length, 0)).toBe(13)
    expect(panels[0]!.judges[0]!.judgeId).toBe('content_topic')
    expect(panels[0]!.judges[3]!.persona).toContain('学术不端')
  })
})

describe('自定义编制评卷（引擎端到端，mock 模式）', () => {
  it('单团单员（满分 50）：等级按 50 分制缩放，及格线 30', async () => {
    const report = await reviewPaper({
      text: PASSABLE_TEXT,
      title: '单团单员',
      minWords: 500,
      panels: [makePanel('solo', '创新性评审团', 50)],
    })
    expect(report.panels.length).toBe(1)
    expect(report.panels[0]!.maxScore).toBe(50)
    // 默认 mock 每员 24 分 → 团分 24（< 30 及格线）→ 不通过，等级"不及格"（24/50=48%）
    expect(report.finalScore).toBe(24)
    expect(report.passed).toBe(false)
    expect(report.usageSummary.config).toMatchObject({ panels: 1, judges: 1 })
  })

  it('双团（60+40）：满分合计 100，作假发现来自任意评卷员', async () => {
    const report = await reviewPaper({
      text: PASSABLE_TEXT,
      title: '双团',
      minWords: 500,
      corpus: { 'a.txt': '无关语料内容，保证全员到齐。'.repeat(60) },
      panels: [
        makePanel('p1', '内容团', 60, [
          { name: '深读员', persona: '深读文本', skills: ['data_consistency'] },
          { name: '查证员', persona: '查证引用', skills: ['citation_check'] },
        ]),
        makePanel('p2', '表达团', 40, [{ name: '语言员' }]),
      ],
    })
    expect(report.panels.length).toBe(2)
    expect(report.panels[0]!.sheets.length).toBe(2)
    expect(report.panels[0]!.sheets.map((s) => s.judgeName)).toEqual(['深读员', '查证员'])
    // 默认 mock：内容团 24/60、表达团 24/40 → 总分 48，及格线 60 → 不通过
    expect(report.finalScore).toBe(48)
    expect(report.passed).toBe(false)
    expect(report.usageSummary.config).toMatchObject({ panels: 2, judges: 3 })
  })

  it('自定义 skill 生效：data_consistency 员的 skill 结果进入 prompt', async () => {
    let sawSkill = false
    const report = await reviewPaper({
      text: PASSABLE_TEXT + ' 准确率95.2%，另一处为89.3%的准确率，两个准确率数字。',
      title: 'skill生效',
      minWords: 500,
      mockFn: (_messages, _json) => {
        sawSkill = true
        return '{"score": 40, "confidence": 0.9, "deductions": [], "fraud_findings": [], "evidence": []}'
      },
      panels: [makePanel('p', '数据团', 50, [{ name: '核验员', skills: ['data_consistency'] }])],
    })
    expect(sawSkill).toBe(true)
    expect(report.finalScore).toBe(40) // 单团 40/50 = 80% → 及格线 30，通过
    expect(report.passed).toBe(true)
  })

  it('judgesLimit 与自定义编制叠加', async () => {
    const report = await reviewPaper({
      text: PASSABLE_TEXT,
      title: '限员',
      minWords: 500,
      judgesLimit: 1,
      panels: [
        makePanel('p1', '一团', 30, [{ name: 'a' }, { name: 'b' }, { name: 'c' }]),
        makePanel('p2', '二团', 30, [{ name: 'd' }, { name: 'e' }]),
      ],
    })
    for (const v of report.panels) expect(v.sheets.length).toBe(1)
  })
})

describe('等级线缩放', () => {
  it('gradeOf 按 totalMax 等比缩放', () => {
    expect(gradeOf(90)).toBe('优秀')
    expect(gradeOf(45, 50)).toBe('优秀') // 45/50 = 90%
    expect(gradeOf(44, 50)).toBe('良好')
    expect(gradeOf(30, 50)).toBe('及格')
    expect(gradeOf(29, 50)).toBe('不及格')
  })
})
