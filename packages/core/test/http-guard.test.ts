/**
 * HTTP 守卫（SSRF 防护）测试（对照原 tests/test_core.py TestHttpGuard）。
 * 仅 http/https + 拒绝本地/环回/私有/保留地址；公开域名需解析校验。
 */

import dns from 'node:dns/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockedHostError, assertPublicUrl, guardedFetch } from '../src/skills/http-guard.js'

async function expectBlocked(url: string): Promise<void> {
  await expect(guardedFetch(url, { timeoutMs: 2000 })).rejects.toBeInstanceOf(BlockedHostError)
}

describe('http guard', () => {
  it('拒绝非 http/https scheme', async () => {
    await expectBlocked('ftp://example.com/file')
  })

  it('拒绝 localhost', async () => {
    await expectBlocked('http://localhost:8600/')
  })

  it('拒绝环回地址', async () => {
    await expectBlocked('http://127.0.0.1/x')
  })

  it('拒绝私有地址', async () => {
    await expectBlocked('http://192.168.1.1/x')
  })

  it('拒绝链路本地地址（169.254/16）', async () => {
    await expectBlocked('http://169.254.1.1/metadata')
  })

  it('拒绝保留地址（240/4 与 0/8）', async () => {
    await expectBlocked('http://240.0.0.1/x')
    await expectBlocked('http://0.0.0.0/x')
  })

  describe('公开域名（mock 解析与 fetch）', () => {
    afterEach(() => vi.restoreAllMocks())

    it('解析为公网地址时放行，且请求 url 原样发出', async () => {
      vi.spyOn(dns, 'lookup').mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
      ] as never)
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      const resp = await guardedFetch('https://api.crossref.org/works?rows=1', {
        headers: { 'User-Agent': 'test' },
      })
      expect(await resp.text()).toBe('{}')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('https://api.crossref.org/works?rows=1')
    })

    it('域名解析到私有地址时拦截（防 DNS rebinding）', async () => {
      vi.spyOn(dns, 'lookup').mockResolvedValue([
        { address: '10.0.0.5', family: 4 },
      ] as never)
      await expect(assertPublicUrl('https://evil.example.com/')).rejects.toBeInstanceOf(BlockedHostError)
    })
  })
})
