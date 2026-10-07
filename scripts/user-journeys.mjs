#!/usr/bin/env node
/**
 * CLI 用户操作模拟：以真实子进程方式运行 packages/cli/bin/yanzheng.mjs，
 * 覆盖终端用户会做的完整操作序列（帮助/错误输入/打回/通过/PPT 导出/PDF 投稿）。
 * 运行：node scripts/user-journeys.mjs   （需先 pnpm -r build）
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(REPO, 'packages/cli/bin/yanzheng.mjs')
const DATA = join(REPO, 'testdata')
const ORIG = 'D:/ZCode/2026年江苏省AI+科学与工程创新实践黑客松'

const work = await mkdtemp(join(tmpdir(), 'yanzheng-journeys-'))
let passed = 0
let failed = 0

function journey(name) {
  console.log(`\n▶ ${name}`)
}

function pass(msg) {
  passed++
  console.log(`  ✅ ${msg}`)
}

function fail(msg, extra) {
  failed++
  console.error(`  ❌ ${msg}${extra ? `\n${extra}` : ''}`)
}

function runCli(args, timeoutMs = 120000) {
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { cwd: work, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, YANZHENG_API_KEY: '' } },
      (error, stdout, stderr) => resolveRun({ code: error ? (error.code ?? 1) : 0, stdout, stderr: stderr || '' }),
    )
  })
}

function assert(cond, msg, extra) {
  if (cond) pass(msg)
  else fail(msg, extra)
}

try {
  // ---------- 旅程 1：新用户查看帮助 ----------
  journey('CLI 旅程 1 · 查看帮助')
  {
    const r = await runCli(['--help'])
    assert(r.code === 0, 'help 退出码 0')
    assert(r.stdout.includes('研证'), '显示产品名')
    assert(r.stdout.includes('--corpus') && r.stdout.includes('--ppt'), '列出全部选项')
  }

  // ---------- 旅程 2：文件路径输错 ----------
  journey('CLI 旅程 2 · 论文路径不存在')
  {
    const r = await runCli(['不存在的论文.txt'])
    assert(r.code === 1, '退出码 1')
    assert(r.stdout.includes('读取论文失败') || r.stderr.includes('读取论文失败'), '给出可读错误', r.stdout + r.stderr)
  }

  // ---------- 旅程 3：不合格投稿（字数/查重/格式三重打回） ----------
  journey('CLI 旅程 3 · 不合格投稿被门检打回（带语料）')
  {
    const out = join(work, '打回报告.html')
    const r = await runCli([join(DATA, 'paper_poor.md'), '--corpus', join(DATA, 'corpus'), '--out', out])
    assert(r.code === 0, '退出码 0（打回也是正常完成）')
    assert(r.stdout.includes('门检未通过'), '输出打回提示')
    assert(r.stdout.includes('字数: 4117'), '报告字数', r.stdout)
    assert(r.stdout.includes('查重率: 38.5%'), '报告查重率', r.stdout)
    const html = await readFile(out, 'utf-8')
    assert(html.includes('打回'), 'HTML 报告含打回章', `${out}`)
    assert(html.includes('未通过硬性门检'), 'HTML 报告含门检明细')
  }

  // ---------- 旅程 4：合格投稿完整评卷（mock 无 key） ----------
  journey('CLI 旅程 4 · 合格投稿完整评卷（无 key 演示路径）')
  {
    const out = join(work, '通过报告.html')
    const r = await runCli([join(DATA, 'paper_good.md'), '--corpus', join(DATA, 'corpus'), '--out', out])
    assert(r.code === 0, '退出码 0')
    assert(r.stdout.includes('总分: 78'), '输出总分 78（默认 mock 四团 24/24/15/15）', r.stdout)
    assert(r.stdout.includes('通过'), '标记通过')
    const html = await readFile(out, 'utf-8')
    assert(html.includes('评卷通过'), 'HTML 报告含「评卷通过」章')
    assert(html.includes('radar'), 'HTML 报告含雷达图脚本')
    assert((html.match(/<details>/g) ?? []).length >= 13, '13 名评卷员明细折叠块')
  }

  // ---------- 旅程 5：同步导出 PPT ----------
  journey('CLI 旅程 5 · 同步导出 PPT')
  {
    const out = join(work, '带ppt报告.html')
    const ppt = join(work, '评卷报告.pptx')
    const r = await runCli([join(DATA, 'paper_good.md'), '--corpus', join(DATA, 'corpus'), '--out', out, '--ppt', ppt])
    assert(r.code === 0, '退出码 0')
    assert(r.stdout.includes('PPT已导出'), '输出 PPT 路径')
    const buf = await readFile(ppt)
    assert(buf.length > 10000, `pptx 文件非空（${buf.length} 字节）`)
    assert(buf[0] === 0x50 && buf[1] === 0x4b, 'pptx 为合法 zip 容器（PK 魔数）')
  }

  // ---------- 旅程 6：PDF 投稿 ----------
  journey('CLI 旅程 6 · PDF 投稿（抽取 + 打回路径）')
  {
    const out = join(work, 'pdf报告.html')
    const r = await runCli([join(ORIG, 'tests/data/竞赛附件.pdf'), '--out', out])
    assert(r.code === 0, '退出码 0')
    assert(r.stdout.includes('开始评卷（竞赛附件.pdf）'), '按文件名识别标题')
    assert(r.stdout.includes('字数: 1660'), 'PDF 抽取字数（1660）', r.stdout)
    assert(r.stdout.includes('门检未通过'), '字数不足打回')
    assert(r.stdout.includes('疑似扫描件') === false, '正常文本 PDF 不触发扫描件提示')
  }

  // ---------- 旅程 7：可选参数边界（--min-words 0 与非法值） ----------
  journey('CLI 旅程 7 · 边界参数（min-words 非法值回退默认）')
  {
    const out = join(work, '边界报告.html')
    const r = await runCli([join(DATA, 'paper_good.md'), '--corpus', join(DATA, 'corpus'), '--min-words', 'abc', '--out', out])
    assert(r.code === 0, '非法数字不崩溃（回退默认 10000）')
    assert(r.stdout.includes('总分'), '完整评卷完成')
  }

  // ---------- 旅程 8：演示模式脚本端到端（demo.ts：13 员 + 否决通路） ----------
  journey('CLI 旅程 8 · 演示模式脚本（pnpm demo 底层路径）')
  {
    const r = await new Promise((resolveRun) => {
      execFile(
        process.execPath,
        [join(REPO, 'node_modules/tsx/dist/cli.mjs'), join(REPO, 'packages/cli/src/demo.ts')],
        { cwd: REPO, timeout: 120000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => resolveRun({ code: error ? 1 : 0, stdout, stderr: stderr || '' }),
      )
    })
    assert(r.code === 0, 'demo 脚本退出码 0', r.stderr)
    assert(r.stdout.includes('门检: 通过'), '门检通过')
    assert(r.stdout.includes('否决=true'), '演示否决通路触发', r.stdout)
    assert(r.stdout.includes('作假疑点: 3 条'), '作假疑点汇总 3 条（含引用捏造）', r.stdout)
  }

  console.log(`\n=== CLI 用户旅程：${passed} 通过 / ${failed} 失败 ===`)
  process.exitCode = failed ? 1 : 0
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => {})
}
