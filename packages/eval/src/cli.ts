/**
 * 研证评测 CLI：三个实验的命令行入口。
 *
 *   yanzheng-eval score-compare --venue ICLR.cc/2023/Conference --limit 5 [--real] [--out 报告.md]
 *   yanzheng-eval recall-curve [--seed 42] [--out 报告.md]
 *   yanzheng-eval retraction-check --refs 引用.txt --csv 撤稿.csv [--out]
 *
 * 网络与成本说明：
 *   score-compare 默认 mock（验证管线，零成本）；--real 用 YANZHENG_API_KEY 真实评卷
 *   （约每样本 1~3 万 tokens，建议先 --limit 5 试跑）。
 *   recall-curve / retraction-check 完全离线。
 */

import { parseArgs } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { demoMockLLM } from '@yanzheng/core'
import {
  fetchOpenReviewSamples,
  runScoreComparison,
  renderComparisonMarkdown,
  buildRecallReport,
  renderRecallMarkdown,
  runRetractionEval,
} from './index.js'

export async function main(argv: string[]): Promise<number> {
  let args
  try {
    args = parseArgs({
      args: argv,
      options: {
        venue: { type: 'string', default: 'ICLR.cc/2023/Conference' },
        limit: { type: 'string', default: '5' },
        real: { type: 'boolean', default: false },
        seed: { type: 'string', default: '42' },
        refs: { type: 'string' },
        csv: { type: 'string' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
    })
  } catch (exc) {
    console.error(String(exc))
    return 1
  }
  if (args.values.help || args.positionals.length !== 1) {
    console.log(`用法：yanzheng-eval <score-compare|recall-curve|retraction-check> [选项]
  score-compare   实验① AI 评分 vs 人类评分对照（OpenReview，--real 才真实评卷）
  recall-curve    实验② 查重召回曲线（可控混淆，离线）
  retraction-check 实验③ 撤稿引用标记（--refs 引用文本 --csv 撤稿CSV，离线）`)
    return args.values.help ? 0 : 1
  }
  const cmd = args.positionals[0]!
  const out = args.values.out

  if (cmd === 'score-compare') {
    const limit = Number.parseInt(args.values.limit ?? '5', 10) || 5
    console.log(`拉取 OpenReview 样本（${args.values.venue} × ${limit}）…`)
    const samples = await fetchOpenReviewSamples({ venueId: args.values.venue!, limit })
    console.log(`有效样本 ${samples.length} 篇`)
    const apiKey = args.values.real ? process.env.YANZHENG_API_KEY ?? null : null
    if (args.values.real && !apiKey) {
      console.error('--real 需要 YANZHENG_API_KEY 环境变量')
      return 1
    }
    const result = await runScoreComparison({
      samples,
      apiKey,
      mockFn: demoMockLLM,
      thinkingStyle: 'off',
      minWords: 30,
    })
    const md = renderComparisonMarkdown(result)
    console.log(md)
    if (out) await writeFile(out, JSON.stringify(result, null, 2), 'utf-8')
    return 0
  }

  if (cmd === 'recall-curve') {
    const { readFile: rf } = await import('node:fs/promises')
    const sources = [
      await rf(new URL('../../../testdata/corpus/source1.txt', import.meta.url), 'utf-8'),
      await rf(new URL('../../../testdata/corpus/source2.txt', import.meta.url), 'utf-8'),
    ]
    // 语料偏短：各重复扩到 ≥1200 有效字符，保证进入分块窗口
    const padded = sources.map((s) => s + s + s + s)
    const report = buildRecallReport(padded, Number.parseInt(args.values.seed ?? '42', 10) || 42)
    const md = renderRecallMarkdown(report)
    console.log(md)
    if (out) await writeFile(out, JSON.stringify(report, null, 2), 'utf-8')
    return 0
  }

  if (cmd === 'retraction-check') {
    if (!args.values.refs || !args.values.csv) {
      console.error('需要 --refs <引用.txt> 与 --csv <撤稿.csv>')
      return 1
    }
    const refsText = await readFile(args.values.refs, 'utf-8')
    const csvText = await readFile(args.values.csv, 'utf-8')
    const r = runRetractionEval({ refsText, csvText, expectHit: [] })
    for (const d of r.details) {
      console.log(`[${d.index}] ${d.retracted ? '已撤稿' : '正常'}${d.reason ? ' · ' + d.reason : ''}`)
    }
    console.log(`\n命中明细已列出（hitRate 需指定 expect 才有意义）`)
    if (out) await writeFile(out, JSON.stringify(r, null, 2), 'utf-8')
    return 0
  }

  console.error(`未知实验：${cmd}`)
  return 1
}
