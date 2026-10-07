#!/usr/bin/env node
/**
 * AGH 闭环端到端验证：把 @yanzheng/agh-plugin 装入真实 AGH daemon，
 * 经 AGH 连续执行 thesis_gate → thesis_sections → thesis_review 三步工具调用，
 * 并导出会话执行记录。LLM 用 AGH 官方回环 provider 夹具（tools/acceptance/provider-fixture.ts，
 * 与仓库公开文档验收同一机制）——工具执行、会话、审计全部是真实 daemon 路径。
 *
 * 前置：node packages/cli 已构建（D:/ZCode/agnes-harness）；
 *       插件发布副本位于 D:/ZCode/agh-plugins/yanzheng-thesis-review。
 * 运行：node scripts/agh-e2e.mjs   （在 TS重构 仓库根）
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const AGNES_REPO = resolve('D:/ZCode/agnes-harness')
const AGNES_CLI = join(AGNES_REPO, 'packages/cli/dist/local/agnes.mjs')
const PLUGIN_DIR = resolve('D:/ZCode/agh-plugins')
const PLUGIN_REF = 'file:./yanzheng-thesis-review'
const PLUGIN_ID = '@yanzheng/agh-plugin'
const HOME = resolve('D:/ZCode/agh-home')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = join(REPO, 'docs')

const env = {
  PATH: process.env.PATH,
  SYSTEMROOT: process.env.SYSTEMROOT,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  AGH_HOME: HOME,
  AGNES_PROFILE: 'local-dev',
}
const run = (args, cwd = PLUGIN_DIR) =>
  new Promise((done, reject) => {
    execFile(
      process.execPath,
      [AGNES_CLI, ...args],
      { cwd, env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error ? reject(Object.assign(new Error(`CLI ${args[0]}: ${stderr.trim()}`), { cause: error })) : done({ stdout, stderr }),
    )
  })

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
    await new Promise((d) => setTimeout(d, 200))
  }
  throw lastErr ?? new Error('waitUntil timeout')
}

const evidence = { steps: [] }
const step = (name, detail) => {
  evidence.steps.push({ name, detail })
  console.log(`STEP OK  ${name}${detail ? ` — ${detail}` : ''}`)
}

const { createClient, memoryJournal } = await import(
  pathToFileURL(join(AGNES_REPO, 'packages/sdk/src/index.node.ts')).href
)
const { startProviderFixture } = await import(
  pathToFileURL(join(AGNES_REPO, 'tools/acceptance/provider-fixture.ts')).href
)

let client
let provider
try {
  // ---------- 0. 隔离实例初始化 ----------
  await rm(HOME, { recursive: true, force: true })
  await mkdir(join(HOME, 'profiles/local-dev'), { recursive: true })
  await writeFile(
    join(HOME, 'profiles/local-dev/profile.yaml'),
    [
      'name: local-dev',
      'computerUse:',
      '  enabled: false',
      'policy:',
      '  capabilityCeiling: [tools, hooks, slots, events, resources, ui, services, network, network.publicRead, tools.invoke, artifacts, subagent]',
      '',
    ].join('\n'),
  )
  assert.match((await run(['daemon', 'status'])).stdout, /running/)
  step('daemon 冷启动（隔离 AGH_HOME）', HOME)

  // ---------- 1. SDK 直连 daemon ----------
  const owner = JSON.parse(await readFile(join(HOME, 'data/daemon/owner.json'), 'utf8'))
  client = createClient({
    transport: { kind: 'unix', path: owner.socketPath },
    auth: { kind: 'local' },
    journal: memoryJournal(),
  })
  await client.initialize()
  step('SDK 连接 daemon socket', owner.socketPath)

  // ---------- 2. inspect → install → trust → enable ----------
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
  const source = { type: 'file', ref: PLUGIN_REF }
  const { preview } = await op('inspect', { source })
  assert.ok(preview, 'inspect preview')
  assert.deepEqual(preview.blockers, [])
  await op('install', { source, expectedIntegrity: preview.integrity })
  await op('trust', { id: PLUGIN_ID, expectedIntegrity: preview.integrity, capabilityHash: preview.capabilityHash })
  await op('enable', { id: PLUGIN_ID })
  evidence.package = {
    id: PLUGIN_ID,
    version: preview.version,
    integrity: preview.integrity,
    capabilityHash: preview.capabilityHash,
    contributions: preview.contributions,
  }
  step('插件安装/信任/启用', `${PLUGIN_ID}@${preview.version} integrity=${preview.integrity.slice(0, 20)}…`)

  const statusOut = (await run(['package', 'status'])).stdout.trim()
  evidence.packageStatus = statusOut
  assert.match(statusOut, new RegExp(`${PLUGIN_ID.replace(/@/g, '\\@')}@[^\\n]+desired=enabled actual=running trusted=true`))
  step('package status: actual=running', statusOut)

  // ---------- 3. 回环 provider 夹具 + 会话 ----------
  const catalogue = await client.config.test({ providerId: 'deepseek' })
  const model = catalogue.models[0]?.id
  assert.ok(model, 'fixture catalogue model')
  provider = await startProviderFixture('研证工具链演示完成。', undefined, model)
  await client.config.save({
    providerId: 'deepseek',
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    expectedRevision: 0,
  })
  step('回环 provider 夹具接入（无真实模型账号）', `model=${model}`)

  const approvals = []
  const session = await client.session.load(undefined, {
    onPermissionRequest: async (request) => {
      approvals.push(request)
      return { optionId: request.options.find((o) => o.kind === 'allow_once').optionId }
    },
  })
  await session.attach()

  const latestToolJSON = (matches) => {
    for (const request of [...provider.requests].reverse()) {
      for (const message of [...request.messages].reverse()) {
        if (message.role !== 'tool' || typeof message.content !== 'string') continue
        try {
          const data = JSON.parse(message.content)
          if (matches(data)) return data
        } catch {}
      }
    }
    throw new Error('未找到匹配的工具结果')
  }

  const demoText = await readFile(join(REPO, 'testdata/demo_paper.txt'), 'utf-8')
  const corpus1 = await readFile(join(REPO, 'testdata/corpus/source1.txt'), 'utf-8')
  const corpus2 = await readFile(join(REPO, 'testdata/corpus/source2.txt'), 'utf-8')

  // ---------- 4. 步骤① thesis_gate（确定性门检） ----------
  provider.queueTool({
    name: 'thesis_gate',
    args: { text: demoText, minWords: 1000, corpus: [{ name: 'source1.txt', text: corpus1 }, { name: 'source2.txt', text: corpus2 }] },
  })
  await session.prompt('请用 thesis_gate 对论文做硬性门检（演示门槛 1000 字）', { signal: AbortSignal.timeout(60000) })
  const gate = latestToolJSON((d) => typeof d.passed === 'boolean' && 'word_count' in d)
  assert.equal(gate.word_count, 1267) // 与 Python 金标一致
  assert.equal(gate.passed, true)
  step('① thesis_gate 经 daemon 真实执行', `word_count=${gate.word_count} passed=${gate.passed} dup=${gate.duplication_rate}`)

  // ---------- 5. 步骤② thesis_sections（章节切分） ----------
  provider.queueTool({ name: 'thesis_sections', args: { text: demoText, bodyCap: 200 } })
  await session.prompt('接着用 thesis_sections 切分章节', { signal: AbortSignal.timeout(60000) })
  const sections = latestToolJSON((d) => Array.isArray(d.sections))
  assert.ok(sections.count >= 1)
  step('② thesis_sections 经 daemon 真实执行', `count=${sections.count}`)

  // ---------- 6. 步骤③ thesis_review（全流程评卷，需审批 → 自动允许） ----------
  const outPath = join(REPO, 'docs', 'AGH评卷报告.html')
  provider.queueTool({
    name: 'thesis_review',
    args: {
      paperPath: join(REPO, 'testdata/demo_paper.txt'),
      outPath,
      minWords: 1000,
      corpusDir: join(REPO, 'testdata/corpus'),
      mock: true,
    },
  })
  await session.prompt('最后运行 thesis_review 全流程评卷（mock 演示模式）', { signal: AbortSignal.timeout(120000) })
  const review = latestToolJSON((d) => 'report_id' in d && 'final_score' in d)
  assert.ok(review.gate_passed === true)
  assert.ok(review.panels.length === 4)
  evidence.review = review
  step('③ thesis_review 经 daemon 真实执行（含审批流）', `report_id=${review.report_id} score=${review.final_score} vetoed=${review.vetoed}`)
  assert.ok(approvals.length >= 1, 'thesis_review 应触发权限审批')
  step('权限审批流验证', `approvals=${approvals.length}`)

  const sessionId = (await client.session.list({})).items[0]?.sessionId
  assert.ok(sessionId, 'sessionId')
  evidence.sessionId = sessionId

  // ---------- 7. 导出执行记录 ----------
  await session.close?.().catch(() => {})
  await client.close()
  client = undefined
  await mkdir(DOCS, { recursive: true })
  await run(['export', sessionId, '--format', 'agnes', '-o', join(DOCS, 'AGH执行记录.jsonl')], REPO)
  await run(['export', sessionId, '--html', '-o', join(DOCS, 'AGH执行记录.html')], REPO)
  const jsonl = await readFile(join(DOCS, 'AGH执行记录.jsonl'), 'utf-8')
  const toolCallLines = jsonl.split('\n').filter((l) => l.includes('thesis_')).length
  step('执行记录导出', `AGH执行记录.jsonl（${toolCallLines} 行含工具调用）/ AGH执行记录.html，sessionId=${sessionId}`)

  console.log('\n=== AGH 闭环验证全部通过 ===')
  evidence.ok = true
} catch (error) {
  evidence.ok = false
  evidence.error = `${error.name}: ${error.message}`
  console.error(`FAIL: ${error.name}: ${error.message}`)
  process.exitCode = 1
} finally {
  try {
    await writeFile(join(DOCS, 'AGH执行记录.验证摘要.json'), JSON.stringify(evidence, null, 2), 'utf-8')
  } catch {}
  if (client) await client.close().catch(() => {})
  await provider?.close().catch(() => {})
  try {
    await run(['daemon', 'stop'])
    console.log('daemon stopped')
  } catch (e) {
    console.error(`daemon stop: ${e.message}`)
  }
}
