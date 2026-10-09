/**
 * 研证 CLI：命令行评卷入口。对照 yanzheng/cli.py。
 *
 * 用法：
 *   yanzheng paper.txt [--corpus 语料目录] [--online] [--out 报告.html]
 *   yanzheng paper.pdf --api-key sk-xxx --out 报告.html
 * 无 api-key 时自动进入 mock 模式（联调用）；key 也可经环境变量 YANZHENG_API_KEY 提供。
 */

import { parseArgs } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  reviewPaper,
  renderHtml,
  loadCorpusDir,
  parsePdfText,
  exportPptx,
  loadRetractionIndex,
} from '@yanzheng/core'

export async function main(argv: string[]): Promise<number> {
  let args
  try {
    args = parseArgs({
      args: argv,
      options: {
        corpus: { type: 'string' },
        online: { type: 'boolean', default: false },
        'api-key': { type: 'string' },
        out: { type: 'string', default: '评卷报告.html' },
        'min-words': { type: 'string', default: '10000' },
        ppt: { type: 'string' },
        retractions: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
    })
  } catch (exc) {
    console.error(String(exc))
    printUsage()
    return 1
  }
  if (args.values.help || args.positionals.length !== 1) {
    printUsage()
    return args.values.help ? 0 : 1
  }

  const paperPath = args.positionals[0]!
  const outPath = args.values.out ?? '评卷报告.html'
  const minWords = Number.parseInt(args.values['min-words'] ?? '10000', 10) || 10000
  const apiKey = args.values['api-key'] ?? process.env.YANZHENG_API_KEY ?? null

  let text: string
  try {
    if (/\.txt$/i.test(paperPath) || /\.md$/i.test(paperPath)) {
      text = await readFile(paperPath, 'utf-8')
    } else {
      text = await parsePdfText(paperPath)
    }
  } catch (exc) {
    console.error(`读取论文失败: ${String(exc)}`)
    return 1
  }

  let corpus: Record<string, string> | null = null
  if (args.values.corpus) {
    corpus = await loadCorpusDir(args.values.corpus)
    console.log(`已加载语料 ${Object.keys(corpus).length} 篇`)
  }
  let retractions: ReturnType<typeof loadRetractionIndex> | undefined
  if (args.values.retractions) {
    retractions = loadRetractionIndex(await readFile(args.values.retractions, 'utf-8'))
    console.log(`已加载撤稿索引 ${retractions.size} 条（引用核查将自动标记已撤稿文献）`)
  }

  console.log(`开始评卷（${basename(paperPath)}）...`)
  const report = await reviewPaper({
    text,
    title: basename(paperPath).replace(/\.[^.]+$/, ''),
    corpus,
    online: args.values.online ?? false,
    apiKey,
    minWords,
    retractions,
  })

  const g = report.gate
  if (!g || !g.passed) {
    console.log('[门检未通过，已打回修改]')
    if (g) {
      console.log(`  字数: ${g.wordCount}（要求≥${g.minWords}）`)
      console.log(`  查重率: ${(g.duplicationRate * 100).toFixed(1)}%（要求<${(g.dupThreshold * 100).toFixed(0)}%）`)
      for (const issue of g.formatIssues) console.log(`  格式: ${issue}`)
      for (const w of g.warnings) console.log(`  警告: ${w}`)
    }
  } else {
    const verdict = report.vetoed ? '否决' : report.passed ? '通过' : '不及格'
    console.log(`总分: ${report.finalScore}  ${verdict}`)
    for (const v of report.panels) {
      console.log(`  ${v.panelName}: ${v.finalScore}/${v.maxScore}`)
    }
    for (const w of g.warnings) console.log(`  警告: ${w}`)
    const usage = report.usageSummary
    const models = Object.entries(usage.models ?? {})
    if (models.length) {
      const parts = models
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([m, u]) => `${m} ${u.calls}次/${(u.prompt_tokens + u.completion_tokens).toLocaleString()}tok`)
      console.log(`成本: 耗时 ${usage.elapsed_seconds}s · ${parts.join(' · ')}`)
    }
  }

  await writeFile(outPath, renderHtml(report), 'utf-8')
  console.log(`报告已生成: ${outPath}`)
  if (args.values.ppt) {
    const pptPath = await exportPptx(report, args.values.ppt)
    console.log(`PPT已导出: ${pptPath}`)
  }
  return 0
}

function printUsage(): void {
  console.log(`研证 · 毕业论文评卷团 Agent（TS 版，AGH 底座原生）

用法：
  yanzheng <paper> [选项]

参数：
  paper                      论文文件（.pdf/.txt/.md）

选项：
  --corpus <目录>            自备查重语料库目录
  --online                   启用在线文献检索/引用核查
  --api-key <key>            DeepSeek/Agnes API key（缺省读 YANZHENG_API_KEY，均无则 mock 模式）
  --out <路径>               输出 HTML 报告路径（默认 评卷报告.html）
  --min-words <n>            门检最低字数（默认 1 万）
  --ppt <路径>               同时导出 PPT 到指定路径
  -h, --help                 显示本帮助`)
}
