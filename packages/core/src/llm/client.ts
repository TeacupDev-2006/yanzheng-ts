/**
 * LLM 客户端：OpenAI 兼容接口（fetch 直连，不依赖 SDK），双模型路由（flash 评卷 / pro 仲裁）+ mock 模式。
 * 对照 yanzheng/llm/deepseek_client.py 逐行为移植。
 *
 * 模型名按 2026-10 官方文档核实：
 * - deepseek-flash  (DeepSeek-V4.1-Flash)：1M 上下文，默认思考模式可关
 * - deepseek-v4-pro (DeepSeek-V4-Pro)：思考/非思考双模式
 * deepseek-chat / deepseek-reasoner 是旧世代别名，勿再使用。
 *
 * 端点与模型全部环境变量可配置（赛事合规：切 Agnes 模型/端点无需改代码）：
 *   YANZHENG_LLM_BASE_URL / YANZHENG_MODEL_JUDGE / YANZHENG_MODEL_ARBITER / YANZHENG_API_KEY
 */

import { guardedFetch } from '../skills/http-guard.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatResult {
  content: string
  model: string
  usage: Record<string, unknown>
}

export interface ChatOptions {
  modelTier?: string
  thinking?: boolean
  responseJson?: boolean
  temperature?: number
  maxTokens?: number
}

export type MockFn = (messages: ChatMessage[], responseJson: boolean) => string

export interface UsageEntry {
  model: string
  prompt_tokens: number
  completion_tokens: number
}

export class LLMError extends Error {}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 宽松 JSON 解析：直接 parse → 剥 ``` 围栏 → 提取首尾大括号（对照 _loads_lenient）。 */
export function loadsLenient(content: string): Record<string, unknown> | null {
  if (!content || !content.trim()) return null
  const stripped = content
    .trim()
    .replace(/^```json/, '')
    .replace(/^```/, '')
    .replace(/```$/, '')
    .trim()
  for (const candidate of [content, stripped]) {
    try {
      const data = JSON.parse(candidate)
      return data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : null
    } catch {
      // 尝试下一个候选
    }
  }
  const m = /\{[\s\S]*\}/.exec(content)
  if (m) {
    try {
      const data = JSON.parse(m[0])
      return data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  return null
}

export interface LLMClientOptions {
  apiKey?: string | null
  baseUrl?: string
  modelFlash?: string
  modelPro?: string
  mock?: boolean
  mockFn?: MockFn | null
  maxRetries?: number
  /**
   * 思考开关的请求体风格：
   * - 'deepseek'（默认）：附 thinking={type}（DeepSeek V4 语义，Agnes/自建 DeepSeek 端点适用）
   * - 'off'：不发该字段（OpenAI/Anthropic/Gemini 等第三方端点会对未知参数报 400）
   */
  thinkingStyle?: 'deepseek' | 'off'
}

/** 校验端点 scheme（仅 http/https；自定义端点允许任意 host，含本地推理服务）。 */
export function assertHttpScheme(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (!/^https?:\/\//.test(base)) {
    throw new LLMError(`LLM 端点仅允许 http/https，收到：${base}`)
  }
  return base
}

/** 拉取 OpenAI 兼容端点的模型清单（GET {base}/models），返回去重排序的模型 id。
 *  与所有技能出站请求一样经 SSRF 守卫（仅 http/https 公网端点可拉取；
 *  本地/内网推理服务不提供拉取，型号由用户手输——chat 调用不受此限制）。 */
export async function listModels(opts: {
  baseUrl: string
  apiKey?: string | null
  timeoutMs?: number
}): Promise<string[]> {
  const base = assertHttpScheme(opts.baseUrl)
  let resp: Response
  try {
    resp = await guardedFetch(`${base}/models`, {
      timeoutMs: opts.timeoutMs ?? 8000,
      headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {},
    })
  } catch (exc) {
    throw new LLMError(`无法拉取模型列表（${base}/models）：${exc instanceof Error ? exc.message : String(exc)}`)
  }
  if (!resp.ok) {
    throw new LLMError(`拉取模型列表失败：HTTP ${resp.status}`)
  }
  const data = (await resp.json()) as { data?: { id?: string }[] }
  const ids = (data.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean)
  return [...new Set(ids)].sort()
}

export class LLMClient {
  readonly mock: boolean
  private readonly mockFn?: MockFn | null
  private readonly modelMap: Record<string, string>
  private readonly maxRetries: number
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly thinkingStyle: 'deepseek' | 'off'
  readonly usageLog: UsageEntry[] = []

  constructor(opts: LLMClientOptions = {}) {
    this.mock = opts.mock ?? !opts.apiKey
    this.mockFn = opts.mockFn ?? null
    this.modelMap = {
      flash: opts.modelFlash ?? process.env.YANZHENG_MODEL_JUDGE ?? 'deepseek-flash',
      pro: opts.modelPro ?? process.env.YANZHENG_MODEL_ARBITER ?? 'deepseek-v4-pro',
    }
    this.maxRetries = opts.maxRetries ?? 3
    this.apiKey = opts.apiKey ?? ''
    // 自定义端点（如本地 Ollama）允许任意 host，但 scheme 必须是 http/https
    this.baseUrl = assertHttpScheme(
      opts.baseUrl ?? process.env.YANZHENG_LLM_BASE_URL ?? 'https://api.deepseek.com',
    )
    this.thinkingStyle = opts.thinkingStyle ?? 'deepseek'
  }

  /** 聚合 usage_log → {"<model>": {calls, prompt_tokens, completion_tokens}} */
  usageSummary(): Record<string, { calls: number; prompt_tokens: number; completion_tokens: number }> {
    const agg: Record<string, { calls: number; prompt_tokens: number; completion_tokens: number }> = {}
    for (const u of this.usageLog) {
      const m = (agg[u.model] ??= { calls: 0, prompt_tokens: 0, completion_tokens: 0 })
      m.calls += 1
      m.prompt_tokens += u.prompt_tokens
      m.completion_tokens += u.completion_tokens
    }
    return agg
  }

  /** 返回 {"content", "model", "usage"}。real 模式 POST {base}/chat/completions。 */
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const modelTier = opts.modelTier ?? 'flash'
    const model = this.modelMap[modelTier] ?? modelTier
    if (this.mock) {
      const content = this.mockResponse(messages, opts.responseJson ?? false)
      return { content, model: `mock-${model}`, usage: {} }
    }

    const maxTokensBase = opts.maxTokens ?? 4096
    const thinking = opts.thinking ?? false
    // 思考模式的推理 token 会计入输出预算，默认上限会被推理耗尽导致 content 为空
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: thinking ? Math.max(maxTokensBase, 16384) : maxTokensBase,
    }
    if (opts.responseJson) body.response_format = { type: 'json_object' }
    // DeepSeek V4 世代通过 thinking 参数控制思考模式（disabled 时 completion tokens 约降一个量级）。
    // 第三方 OpenAI 兼容端点会对未知参数报 400，因此按 thinkingStyle 决定是否携带。
    if (this.thinkingStyle === 'deepseek') {
      body.thinking = { type: thinking ? 'enabled' : 'disabled' }
    }

    let lastErr: unknown = null
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const resp = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        })
        if (!resp.ok) {
          const err = new LLMError(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
          ;(err as LLMError & { status?: number }).status = resp.status
          throw err
        }
        const data = (await resp.json()) as {
          choices?: { message?: { content?: string } }[]
          usage?: Record<string, unknown>
        }
        const usage = data.usage ?? {}
        this.usageLog.push({
          model,
          prompt_tokens: Number(usage.prompt_tokens ?? 0),
          completion_tokens: Number(usage.completion_tokens ?? 0),
        })
        return {
          content: data.choices?.[0]?.message?.content ?? '',
          model,
          usage,
        }
      } catch (exc) {
        lastErr = exc
        const status = (exc as LLMError & { status?: number }).status
        if (!status || !RETRYABLE_STATUS.has(status) || attempt === this.maxRetries - 1) {
          if (exc instanceof LLMError) throw exc
          throw new LLMError(`LLM 调用失败（${model}）: ${String(exc)}`)
        }
        await sleep(2 ** attempt * 1.5 * 1000)
      }
    }
    throw new LLMError(`LLM 调用失败（${model}）: ${String(lastErr)}`)
  }

  /** chat 的 JSON 便捷封装，自动解析 content 为 dict（容错 ```json 围栏）。
   *  content 为空或非 JSON 时自动关思考重试一次。 */
  async chatJson(messages: ChatMessage[], opts: ChatOptions = {}): Promise<Record<string, unknown>> {
    const kw: ChatOptions = { responseJson: true, ...opts }
    let resp = await this.chat(messages, kw)
    let data = loadsLenient(resp.content)
    if (data === null) {
      resp = await this.chat(messages, { ...kw, thinking: false, temperature: Math.min(kw.temperature ?? 0.3, 0.2) })
      data = loadsLenient(resp.content)
      if (data === null) {
        throw new LLMError(`LLM 返回非 JSON: ${resp.content.slice(0, 200)}`)
      }
    }
    data._meta = { model: resp.model, usage: resp.usage }
    return data
  }

  /** 默认 mock：按注入的 MOCK_INSTRUCTION 标记返回确定性、合法的 JSON。 */
  private mockResponse(messages: ChatMessage[], responseJson: boolean): string {
    if (this.mockFn) return this.mockFn(messages, responseJson)
    const text = messages.map((m) => m.content ?? '').join('\n')
    if (responseJson) {
      const m = /MOCK_INSTRUCTION:\s*(\S+)/.exec(text)
      if (m?.[1]) {
        const marker = m[1]
        if (marker.startsWith('panel_arb_')) {
          return JSON.stringify({
            final_score: 20.0,
            drop_outlier: null,
            reason: 'default-mock 复核',
          })
        }
        if (marker === 'chief_veto') {
          return JSON.stringify({
            veto: false,
            veto_reasons: [],
            downgrade_to_deduction: true,
            reason: 'default-mock 复核',
          })
        }
        return JSON.stringify({
          score: 24.0,
          confidence: 0.8,
          deductions: [
            {
              severity: '轻微',
              location: 'mock 定位',
              description: `default-mock 扣分点（${marker}）`,
              suggestion: 'mock 建议',
              deduction: 1,
            },
          ],
          fraud_findings: [],
          evidence: [`default-mock:${marker}`],
        })
      }
      return JSON.stringify({ note: 'default-mock' })
    }
    return '[default-mock] 评语占位'
  }
}
