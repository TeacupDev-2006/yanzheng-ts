#!/usr/bin/env node
/**
 * 轻量重装：把最新构建的 @yanzheng/agh-plugin 重新装入正在运行的 AGH daemon
 * （remove → inspect → install → trust → enable）。仅做包管理，不跑工具验证——
 * 完整闭环请用 scripts/agh-e2e.mjs。
 *
 * 前置：插件发布副本已更新（D:/ZCode/agnes-harness/yanzheng-thesis-review，
 * file: 来源按 daemon 启动目录解析）；daemon 运行中。
 * 运行：agnes-harness/node_modules/.bin/tsx scripts/agh-reinstall.mjs（cwd = agnes-harness）
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const AGNES_REPO = resolve('D:/ZCode/agnes-harness')
const PLUGIN_REF = 'file:./yanzheng-thesis-review'
const PLUGIN_ID = '@yanzheng/agh-plugin'
const HOME = resolve('D:/ZCode/agh-home')

const { createClient, memoryJournal } = await import(
  pathToFileURL(join(AGNES_REPO, 'packages/sdk/src/index.node.ts')).href
)

const owner = JSON.parse(await readFile(join(HOME, 'data/daemon/owner.json'), 'utf8'))
const client = createClient({
  transport: {
    kind: 'unix',
    path: owner.socketPath,
    serverIdentity: { pid: owner.pid, processStartId: owner.processStartId },
  },
  auth: { kind: 'local' },
  journal: memoryJournal(),
})
await client.initialize()
console.log('SDK connected:', owner.socketPath)

const common = { profile: 'local-dev', clientId: await client.clientId() }
const op = async (kind, params) => {
  const receipt = await client.packages[kind]({ ...common, commandId: `yanzheng-${Date.now()}-${kind}`, ...params })
  return waitUntil(async () => {
    const result = await client.packages.operation.get({ profile: common.profile, operationId: receipt.operationId })
    if (result.state === 'failed' || result.state === 'cancelled') {
      throw new Error(`${kind} failed: ${result.error?.code ?? result.state}`)
    }
    return ['completed', 'rolled-back'].includes(result.state) ? result : undefined
  })
}

const waitUntil = async (fn, ms = 30000) => {
  const deadline = Date.now() + ms
  let lastErr
  while (Date.now() < deadline) {
    try {
      const r = await fn()
      if (r) return r
    } catch (e) {
      lastErr = e
    }
    await new Promise((d) => setTimeout(d, 300))
  }
  throw lastErr ?? new Error('waitUntil timeout')
}

// 旧版本存在则先停用再移除（状态机要求：running 包不可直接 remove；首次安装时忽略失败）
try {
  await op('disable', { id: PLUGIN_ID })
  await op('remove', { id: PLUGIN_ID })
  console.log('removed old', PLUGIN_ID)
} catch {
  console.log('no old installation to remove')
}

const source = { type: 'file', ref: PLUGIN_REF }
const { preview } = await op('inspect', { source })
assert.ok(preview, 'inspect preview')
assert.deepEqual(preview.blockers, [])
console.log('preview:', PLUGIN_ID, preview.version, preview.integrity?.slice(0, 24))
await op('install', { source, expectedIntegrity: preview.integrity })
await op('trust', { id: PLUGIN_ID, expectedIntegrity: preview.integrity, capabilityHash: preview.capabilityHash })
await op('enable', { id: PLUGIN_ID })
console.log(`installed ${PLUGIN_ID}@${preview.version} → enabled/trusted`)

await client.close()
