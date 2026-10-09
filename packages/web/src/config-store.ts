/**
 * 评卷委员会配置存储：web 形态下的持久化配置（AI 设置 + 评审团编制）。
 *
 * 存储位置：项目根 data/rubric.json（gitignore 排除——含用户自填的 key 时属于敏感数据）。
 * AI key 单独说明：key 可以存在配置文件里（本机自用），但 /review 始终优先用表单里当场填的 key。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizePanels, ALL_PANELS, type PanelSpec } from '@yanzheng/core'

export interface LlmConfig {
  preset: string
  baseUrl: string
  /** 留空 = 演示模式（不落盘明文 key：存 null） */
  apiKey: string | null
  modelJudge: string
  modelArbiter: string
  thinkingStyle: 'deepseek' | 'off'
}

export interface RubricConfig {
  llm: LlmConfig
  panels: PanelSpec[]
}

export const DEFAULT_LLM: LlmConfig = {
  preset: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKey: null,
  modelJudge: 'deepseek-flash',
  modelArbiter: 'deepseek-v4-pro',
  thinkingStyle: 'deepseek',
}

function dataDir(): string {
  // 测试可经 YANZHENG_DATA_DIR 隔离；默认 <项目根>/data
  // （src/app.ts → packages/web/src → 项目根三层）
  return process.env.YANZHENG_DATA_DIR ?? join(fileURLToPath(new URL('../../../data/', import.meta.url)))
}

function configFile(): string {
  return join(dataDir(), 'rubric.json')
}

export async function loadConfig(): Promise<RubricConfig> {
  try {
    const raw = JSON.parse(await readFile(configFile(), 'utf-8')) as Partial<RubricConfig>
    return {
      llm: { ...DEFAULT_LLM, ...(raw.llm ?? {}) },
      panels: raw.panels ? normalizePanels(raw.panels) : [...ALL_PANELS],
    }
  } catch {
    return { llm: { ...DEFAULT_LLM }, panels: [...ALL_PANELS] }
  }
}

export async function saveConfig(input: unknown): Promise<RubricConfig> {
  const raw = (input ?? {}) as {
    llm?: Partial<LlmConfig> & { keep?: boolean }
    panels?: unknown
  }
  const existing = await loadConfig()

  // panels: null = 恢复默认 4 团 13 员；未传 = 保持不变；其余 = 校验并保存
  const panels =
    raw.panels === null
      ? [...ALL_PANELS]
      : raw.panels === undefined
        ? existing.panels
        : normalizePanels(raw.panels)

  // llm: 未传或 {keep:true} = 以已存值为基底；apiKey 字段未出现 = 保留已存 key（页面掩码不回写）
  let llm: LlmConfig = { ...existing.llm }
  if (raw.llm && !raw.llm.keep) {
    llm = {
      preset: String(raw.llm.preset ?? existing.llm.preset),
      baseUrl: String(raw.llm.baseUrl ?? '').trim(),
      apiKey: existing.llm.apiKey,
      modelJudge: String(raw.llm.modelJudge ?? '').trim(),
      modelArbiter: String(raw.llm.modelArbiter ?? '').trim(),
      thinkingStyle: raw.llm.thinkingStyle === 'off' ? 'off' : 'deepseek',
    }
  }
  if (raw.llm && 'apiKey' in raw.llm) {
    // 显式带 apiKey 字段：null 清除（回演示模式），字符串则覆盖——即使 keep:true 也生效
    llm = { ...llm, apiKey: raw.llm.apiKey ? String(raw.llm.apiKey) : null }
  }
  if (llm.baseUrl && !/^https?:\/\//.test(llm.baseUrl)) {
    throw new Error('端点仅允许 http/https')
  }
  const config: RubricConfig = { llm, panels }
  await mkdir(dirname(configFile()), { recursive: true })
  await writeFile(configFile(), JSON.stringify(config, null, 2), 'utf-8')
  return config
}
