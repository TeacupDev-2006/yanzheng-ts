/** 实验①OpenReview 客户端测试：mock fetch，验证拉取/评分解析/均值计算。 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchOpenReviewSamples, parseRating } from '../src/openreview.js'

afterEach(() => vi.unstubAllGlobals())

describe('parseRating', () => {
  it('解析 OpenReview 各型 rating', () => {
    expect(parseRating('6: marginally above the acceptance threshold')).toBe(6)
    expect(parseRating('3: clear reject')).toBe(3)
    expect(parseRating(-1)).toBe(-1)
    expect(parseRating('9: Top 5% of submitted papers')).toBe(9)
    expect(parseRating('no rating')).toBeNull()
    expect(parseRating(undefined)).toBeNull()
  })
})

describe('fetchOpenReviewSamples（mock 传输层）', () => {
  it('拉取提交+评审，均值正确，缺失评审记 null', async () => {
    const submissions = {
      notes: [
        {
          id: 'paper1',
          content: { title: { value: '论文甲' }, abstract: { value: '摘要甲' } },
        },
        {
          id: 'paper2',
          content: { title: { value: '论文乙' }, abstract: { value: '摘要乙' } },
        },
        {
          id: 'paper3',
          content: { title: { value: '缺摘要' } },
        },
      ],
    }
    const reviews: Record<string, { notes: unknown[] }> = {
      paper1: {
        notes: [
          { content: { rating: { value: '6: weak accept' }, review: { value: '方法可行' } } },
          { content: { rating: { value: '8: accept' }, review: { value: '实验充分' } } },
        ],
      },
      paper2: { notes: [{ content: { summary: { value: '无评分评审' } } }] },
    }
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.includes('content.venueid=')) return new Response(JSON.stringify(submissions), { status: 200 })
      for (const [id, body] of Object.entries(reviews)) {
        if (u.includes(`forum=${id}`)) return new Response(JSON.stringify(body), { status: 200 })
      }
      return new Response(JSON.stringify({ notes: [] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const samples = await fetchOpenReviewSamples({ venueId: 'ICLR.cc/2024/Conference', limit: 3, delayMs: 0 })
    expect(samples.length).toBe(2) // paper3 缺摘要被跳过
    expect(samples[0]!.title).toBe('论文甲')
    expect(samples[0]!.humanScore).toBe(7) // (6+8)/2
    expect(samples[0]!.reviewsText).toEqual(['方法可行', '实验充分'])
    expect(samples[1]!.humanScore).toBeNull() // 评审无评分
  })
})
