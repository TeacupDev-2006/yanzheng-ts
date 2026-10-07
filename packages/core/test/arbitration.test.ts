/** 仲裁与量规测试（对照原 tests/test_core.py TestArbitration / TestRubric）。 */

import { describe, expect, it } from 'vitest'
import { panelArbitration } from '../src/arbiter.js'
import { LLMClient } from '../src/llm/client.js'
import { ALL_PANELS, CONTENT_PANEL, SPREAD_RATIO_THRESHOLD } from '../src/rubric.js'
import type { ScoreSheet } from '../src/models.js'

function sheet(judgeId: string, panel: string, score: number, name = ''): ScoreSheet {
  return {
    judgeId,
    judgeName: name || judgeId,
    panel,
    score,
    maxScore: 40,
    deductions: [],
    evidence: [],
    confidence: 1,
    model: '',
    rawResponse: '',
  }
}

describe('arbitration', () => {
  it('分差在阈值内取均值', async () => {
    const sheets = [sheet('a', 'content', 30), sheet('b', 'content', 31), sheet('c', 'content', 29)]
    const client = new LLMClient({ mock: true })
    const verdict = await panelArbitration(CONTENT_PANEL, sheets, client)
    expect(verdict.finalScore).toBe(30.0)
    expect(verdict.arbitration[0]!.action).toBe('spread_ok')
  })

  it('分差超阈值触发团长复核', async () => {
    let calls = 0
    const client = new LLMClient({
      mock: true,
      mockFn: () => {
        calls += 1
        return '{"final_score": 27.0, "drop_outlier": "c", "reason": "离群"}'
      },
    })
    const sheets = [sheet('a', 'content', 34), sheet('b', 'content', 33), sheet('c', 'content', 12)]
    const verdict = await panelArbitration(CONTENT_PANEL, sheets, client)
    expect(calls).toBeGreaterThan(0) // 分差超阈值必须触发团长复核
    expect(verdict.finalScore).toBe(27.0)
    expect(verdict.arbitration.some((a) => a.action === 're_review')).toBe(true)
    expect(verdict.arbitration.some((a) => a.action === 'drop_outlier')).toBe(true)
  })

  it('阈值常量', () => {
    expect(SPREAD_RATIO_THRESHOLD).toBe(0.15)
  })
})

describe('rubric', () => {
  it('4 团 13 员', () => {
    expect(ALL_PANELS.length).toBe(4)
    expect(ALL_PANELS.reduce((acc, p) => acc + p.judges.length, 0)).toBe(13)
  })

  it('每名评卷员 ≤2 个 skill', () => {
    for (const p of ALL_PANELS) {
      for (const j of p.judges) {
        expect(j.skills.length).toBeLessThanOrEqual(2)
      }
    }
  })

  it('团满分合计 100', () => {
    expect(ALL_PANELS.reduce((acc, p) => acc + p.maxScore, 0)).toBe(100)
  })
})
