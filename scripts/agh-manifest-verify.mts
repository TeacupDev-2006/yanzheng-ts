/**
 * AGH 官方机制级插件校验（对照 tools/public-docs/examples.test.ts 的 idiom）：
 * 用 AGH 自己的 parseAgnesPluginEntries / checkToolDef / validateAgainst 校验
 * 研证插件的清单声明、工具 schema 与执行结果 —— 不起 daemon，无 native 依赖。
 *
 * 运行（在 agnes-harness 目录）：node_modules/.bin/tsx "<TS重构>/scripts/agh-manifest-verify.mts"
 */

import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const AGNES = resolve('D:/ZCode/agnes-harness')
const PLUGIN_DIR = resolve('D:/ZCode/agh-plugins/yanzheng-thesis-review')
const REPO = resolve('D:/ZCode/2026年江苏省AI+科学与工程创新实践黑客松 TS重构')

const { checkToolDef } = await import(
  pathToFileURL(resolve(AGNES, 'packages/extension-api/src/index.js')).href
)
type ToolDef = {
  name: string
  description: string
  parameters: unknown
  meta?: Record<string, unknown>
  execute(args: Record<string, unknown>, ctx: unknown): Promise<{ content?: unknown; structured?: unknown }>
}
const { parseAgnesPluginEntries } = await import(
  pathToFileURL(resolve(AGNES, 'packages/package-manager/src/plugin-manifest.js')).href
)
const { validateAgainst } = await import(
  pathToFileURL(resolve(AGNES, 'packages/protocol/src/validate.js')).href
)

// ① 清单校验（AGH 官方解析器）
const pkg = JSON.parse(await readFile(resolve(PLUGIN_DIR, 'package.json'), 'utf8'))
const entries = parseAgnesPluginEntries(pkg.name, pkg.agnes.plugins)
assert.equal(entries.length, 1)
assert.deepEqual(entries[0]!.inject, ['extension'])
assert.equal(entries[0]!.id, 'ext:yanzheng/agh-plugin')
console.log(`PASS manifest: ${entries[0]!.id} inject=[extension] export=${entries[0]!.export}`)

// ② 模块加载 + 注册捕获（同官方示例：fixture 而非 Host 授权声明）
const mod = await import(pathToFileURL(resolve(PLUGIN_DIR, 'dist/index.js')).href)
const plugin = mod[entries[0]!.export!]
assert.equal(typeof plugin?.apply, 'function')
const tools = new Map<string, ToolDef>()
const hooks: string[] = []
plugin.apply({
  extension: () => ({
    registerTool(def: ToolDef) {
      tools.set(def.name, def)
    },
    on(event: string) {
      hooks.push(event)
    },
    ctx: { log: { info: () => {}, error: () => {} } },
  }),
})
assert.deepEqual(
  [...tools.keys()].sort(),
  ['thesis_dedup', 'thesis_gate', 'thesis_review', 'thesis_sections'],
)
console.log(`PASS register: ${[...tools.keys()].sort().join(' / ')}; hooks=${JSON.stringify(hooks)}`)

// ③ 逐工具 checkToolDef（AGH 官方工具定义校验器）
for (const [name, def] of tools) {
  const result = checkToolDef(def, { prefix: '' }) as { ok: boolean; problems?: string[] }
  if (!result.ok) throw new Error(`checkToolDef(${name}) 拒绝: ${JSON.stringify(result.problems)}`)
}
console.log('PASS checkToolDef ×4')

// ④ schema validateAgainst 正反例 + 真实执行
const demoText = await readFile(resolve(REPO, 'testdata/demo_paper.txt'), 'utf-8')
const gate = tools.get('thesis_gate')!
assert.equal(validateAgainst(gate.parameters, { text: demoText, minWords: 1000 }).ok, true)
assert.equal(validateAgainst(gate.parameters, { text: 42 }).ok, false)
assert.equal(validateAgainst(gate.parameters, { text: 'x', unknown: 1 }).ok, false)
const gateOut = (await gate.execute({ text: demoText, minWords: 1000 }, {} as never)).structured as {
  passed: boolean
  word_count: number
}
assert.equal(gateOut.word_count, 1267) // Python 金标
assert.equal(gateOut.passed, true)
console.log('PASS thesis_gate schema + execute (word_count=1267)')

const sections = tools.get('thesis_sections')!
const secOut = (
  await sections.execute({ text: '第一章 绪论\nA\n第二章 方法\nB' }, {} as never)
).structured as { count: number }
assert.equal(secOut.count, 2)
console.log('PASS thesis_sections execute')

const dedup = tools.get('thesis_dedup')!
assert.equal(validateAgainst(dedup.parameters, { text: 'x' }).ok, false) // corpus 必填
const longText = '研证分块查重验证文本。'.repeat(80)
const dedupOut = (
  await dedup.execute(
    { text: longText, corpus: [{ name: 'self', text: longText }] },
    {} as never,
  )
).structured as { rate: number }
assert.equal(dedupOut.rate, 1.0)
console.log('PASS thesis_dedup schema + execute')

const review = tools.get('thesis_review')!
const reviewOut = (
  await review.execute(
    {
      paperPath: resolve(REPO, 'testdata/demo_paper.txt'),
      outPath: resolve(REPO, 'docs', 'AGH校验报告.html'),
      minWords: 1000,
      corpusDir: resolve(REPO, 'testdata/corpus'),
      mock: true,
    },
    {} as never,
  )
).structured as { report_id: string; final_score: number; panels: unknown[]; vetoed: boolean }
assert.equal(reviewOut.panels.length, 4)
assert.equal(typeof reviewOut.final_score, 'number')
console.log(`PASS thesis_review execute (report_id=${reviewOut.report_id} score=${reviewOut.final_score})`)

console.log('\n=== AGH 机制级校验全部通过（清单/注册/schema/执行） ===')
