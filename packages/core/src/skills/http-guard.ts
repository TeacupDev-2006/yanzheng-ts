/**
 * 出站 HTTP 守卫：服务端请求仅允许 http/https 且目标必须为公网地址。
 * 对照 yanzheng/skills/http_guard.py（SSRF 防护）：
 * - scheme 仅允许 http/https
 * - host 拒绝 localhost、环回、私有、链路本地、组播与保留地址
 * - 域名解析后逐一校验解析地址（基础防 DNS rebinding）
 * 所有 skill 的服务端请求必须经 guardedFetch 发出。
 */

import dns from 'node:dns/promises'
import net from 'node:net'

const ALLOWED_SCHEMES = new Set(['http', 'https'])

export class BlockedHostError extends Error {}

interface IpClass {
  loopback: boolean
  private: boolean
  linkLocal: boolean
  multicast: boolean
  reserved: boolean
  unspecified: boolean
}

/** IPv4 分类（对照 Python ipaddress 模块的 is_* 属性，覆盖其默认私有/保留段）。 */
function classifyIpv4(ip: string): IpClass {
  const octets = ip.split('.').map((o) => Number.parseInt(o, 10))
  const a = octets[0] ?? 0
  const b = octets[1] ?? 0
  const c = octets[2] ?? 0
  const loopback = a === 127
  const linkLocal = a === 169 && b === 254
  const multicast = a >= 224 && a <= 239
  const unspecified = a === 0 && b === 0 && c === 0 && (octets[3] ?? 0) === 0
  const privateNet =
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  const reserved =
    a === 0 || // 0.0.0.0/8
    a >= 240 || // 240.0.0.0/4 + 255.255.255.255
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 基准测试
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  return { loopback, private: privateNet, linkLocal, multicast, reserved, unspecified }
}

/** IPv6 分类。 */
function classifyIpv6(ip: string): IpClass {
  const lower = ip.toLowerCase()
  const v4mapped = lower.startsWith('::ffff:')
  if (v4mapped) return classifyIpv4(lower.slice(7))
  const loopback = lower === '::1'
  const unspecified = lower === '::'
  // fc00::/7 唯一本地、fe80::/10 链路本地、ff00::/8 组播
  const firstWord = Number.parseInt(lower.split(':')[0] ?? '0', 16)
  const privateNet = firstWord >= 0xfc00 && firstWord <= 0xfdff
  const linkLocal = firstWord >= 0xfe80 && firstWord <= 0xfebf
  const multicast = (firstWord & 0xff00) === 0xff00
  const reserved =
    !loopback && !unspecified && !privateNet && !linkLocal && !multicast && firstWord < 0x2000
  return { loopback, private: privateNet, linkLocal, multicast, reserved, unspecified }
}

function classify(ip: string): IpClass {
  return net.isIP(ip) === 6 ? classifyIpv6(ip) : classifyIpv4(ip)
}

function forbiddenIp(ip: string): boolean {
  const c = classify(ip)
  return c.loopback || c.private || c.linkLocal || c.multicast || c.reserved || c.unspecified
}

function forbiddenHost(host: string): boolean {
  const h = (host ?? '').trim().toLowerCase()
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return true
  }
  const ipType = net.isIP(h)
  if (ipType) return forbiddenIp(h)
  return false // 域名：由解析后的地址校验兜底
}

export interface GuardedFetchOptions {
  timeoutMs?: number
  headers?: Record<string, string>
  method?: string
}

/** 校验 URL 合法性（scheme 白名单 + host 黑名单 + 解析地址逐一校验），返回解析后的 URL。 */
export async function assertPublicUrl(url: string): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new BlockedHostError(`URL 无法解析：${url}`)
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol.replace(':', ''))) {
    throw new BlockedHostError(`仅允许 http/https，拒绝 scheme=${parsed.protocol}`)
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '') || ''
  if (forbiddenHost(host)) {
    throw new BlockedHostError(`拒绝本地/私有/保留主机：${JSON.stringify(host)}`)
  }
  let addresses: string[]
  try {
    const infos = await dns.lookup(host, { all: true, verbatim: true })
    addresses = infos.map((i) => i.address)
  } catch {
    throw new BlockedHostError(`主机解析失败：${JSON.stringify(host)}`)
  }
  for (const ip of addresses) {
    if (forbiddenIp(ip)) {
      throw new BlockedHostError(`主机解析到私有/保留地址：${host} -> ${ip}`)
    }
  }
  return parsed
}

/** 带 SSRF 防护的 fetch：scheme 白名单 + host 黑名单 + 解析地址校验 + 超时。 */
export async function guardedFetch(url: string, opts: GuardedFetchOptions = {}): Promise<Response> {
  await assertPublicUrl(url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000)
  try {
    return await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers ?? {},
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}
