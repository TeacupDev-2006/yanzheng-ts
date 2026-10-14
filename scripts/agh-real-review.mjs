#!/usr/bin/env node
/**
 * AGH 真实评卷验证：经 AGH 会话（DeepSeek 助手自主编排）对造假论文跑 thesis_review，
 * 验证插件 0.6.1 的环境变量 LLM 接入——daemon 进程须带 YANZHENG_API_KEY（+可选
 * YANZHENG_CONCURRENCY）启动。产出 docs/fake_thesis_agh_real.html 与执行记录。
 *
 * 运行：agnes-harness/node_modules/.bin/tsx scripts/agh-real-review.mjs（cwd = agnes-harness）
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const AGNES_REPO = resolve('D:/ZCode/agnes-harness')
const PLUGIN_ID = '@yanzheng/agh-plugin'
const HOME = resolve('D:/ZCode/agh-home')
const REPO = resolve('D:/ZCode/2026年江苏省AI+科学与工程创新实践黑客松 TS重构')
const PAPER = join(REPO, 'testdata', 'fake_thesis.txt')
const OUT = join(REPO, 'docs', 'fake_thesis_agh_real.html')
const API_KEY = process.env.YANZHENG_API_KEY
const AGNES_KEY = process.env.AGNES_API_KEY
assert.ok(API_KEY, '需要 YANZHENG_API_KEY 环境变量（工具内部评卷，daemon 进程环境）')
assert.ok(AGNES_KEY, '需要 AGNES_API_KEY 环境变量（AGH 助手编排模型）')

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
console.log('[1] SDK connected:', owner.socketPath)

// AGH 助手走 agnes-ai（赛事端点，已验证连通）；工具内部评卷走 daemon 环境的 DeepSeek key
const catalogue = await client.config.test({ providerId: 'agnes-ai' })
const model = process.env.YANZHENG_MODEL_JUDGE || catalogue.models?.find((m) => /flash/i.test(m.id))?.id
assert.ok(model, `agnes-ai catalogue 无可用模型: ${JSON.stringify(catalogue.models)?.slice(0, 200)}`)
const current = await client.config.get()
await client.config.save({
  providerId: 'agnes-ai',
  apiKey: AGNES_KEY,
  model,
  expectedRevision: current.revision,
})
console.log('[2] AGH 助手模型已配置: agnes-ai /', model)

const approvals = []
await client.workspace.add(REPO)
const session = await client.session.new({ cwd: REPO })
session.onPermissionRequest(async (request) => {
  approvals.push(request)
  console.log('[审批]', JSON.stringify(request).slice(0, 160))
  return { optionId: request.options.find((o) => o.kind === 'allow_once')?.optionId ?? request.options[0].optionId }
})
console.log('[3] 会话已建立（审批自动放行）')

const t0 = Date.now()
await session.prompt(
  `请用研证评卷工具对论文 ${PAPER} 做全流程评审：调用 thesis_review（参数 paperPath=${PAPER}，` +
    `outPath=${OUT}，minWords 10000，corpusDir=${join(REPO, 'testdata', 'cor')}pus）。` +
    `注意：严禁传 mock 参数（保持默认 false 才会走真实 LLM 评卷）；该工具真实评卷需数分钟，` +
    `超时属正常，请耐心等待勿中断勿重试。完成后告诉我：评审模式（真实/mock）、总分、是否一票否决及原因。`,
  { signal: AbortSignal.timeout(1500000) },
).catch((e) => console.error('[prompt 异常，继续断言产物]', e.message))
console.log(`[4] prompt 完成，耗时 ${Math.round((Date.now() - t0) / 1000)}s，审批数=${approvals.length}`)

const html = await readFile(OUT, 'utf-8')
const mode = html.match(/评审模式[：:]\s*(\S+)/)?.[1] ?? (html.includes('mock') ? 'mock?' : 'real?')
const score = html.match(/class="num"[^>]*>([\d.]+)</)?.[1] ?? '?'
const vetoed = /一票否决|vetoed["：:]\s*true/i.test(html) || html.includes('否决')
console.log('=== 结果 ===')
console.log('mode:', mode, '| score:', score, '| veto 关键词命中:', vetoed)
assert.ok(approvals.length >= 1, 'thesis_review 应触发审批')
assert.ok(!/mock/i.test(mode), `评审模式应为真实 LLM，实际=${mode}`)

// 导出执行记录（研证工具调用 + 审批）
const sessionId = (await client.session.list({})).items[0]?.sessionId
await session.close?.().catch(() => {})
await client.close()
const { execFile } = await import('node:child_process')
const { promisify } = await import('node:util')
const run = promisify(execFile)
await run(process.execPath, [
  join(AGNES_REPO, 'packages/cli/dist/local/agnes.mjs'),
  'export', sessionId, '--format', 'agnes', '-o', join(REPO, 'docs', 'AGH真实评卷执行记录.jsonl'),
], { cwd: AGNES_REPO, env: { ...process.env, AGH_HOME: HOME, AGNES_PROFILE: 'local-dev' }, timeout: 60000 })
console.log('=== AGH 真实评卷验证通过 === sessionId:', sessionId)
