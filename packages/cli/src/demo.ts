/**
 * mock 全流程演示：门检 → 4 团 13 员评卷 → 两级仲裁 → HTML 报告。
 * 对照 tests/demo_run.py。运行：pnpm --filter @yanzheng/cli demo
 */

import { writeFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { reviewPaper, renderHtml, demoMockLLM } from '@yanzheng/core'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../../..')

// 短语料（触发门检查重逻辑有非零值；内容与示例论文无关）
const CORPUS: Record<string, string> = {
  'ref_a.txt': '深度学习模型在图像分类任务中的应用综述。'.repeat(50),
  'ref_b.txt': '校园垃圾分类政策实施效果评估与对策研究。'.repeat(50),
}

async function main(): Promise<void> {
  console.log('=== 研证 mock 全流程演示（TS 版） ===')
  const demoPaper = await readFile(join(REPO_ROOT, 'testdata/demo_paper.txt'), 'utf-8')

  const report = await reviewPaper({
    text: demoPaper,
    title: '面向校园场景的智能垃圾分类系统设计与实现',
    corpus: CORPUS,
    apiKey: null, // 无 key → mock 模式
    mockFn: demoMockLLM,
    minWords: 1000, // demo 论文为精简片段，演示时降低字数门槛（生产默认 1 万）
  })

  if (!report.gate?.passed) throw new Error('门检应通过')
  console.log(
    `门检: 通过  字数=${report.gate.wordCount}  查重率=${(report.gate.duplicationRate * 100).toFixed(1)}%`,
  )

  const out = join(REPO_ROOT, 'demo_评卷报告.html')
  await writeFile(out, renderHtml(report), 'utf-8')
  console.log(`报告: ${out}`)
  console.log(`总分: ${report.finalScore}  否决=${report.vetoed}`)
  for (const v of report.panels) {
    console.log(`  ${v.panelName}: ${v.finalScore}/${v.maxScore}  (评卷员${v.sheets.length}人)`)
  }
  console.log(`作假疑点: ${report.fraudFindings.length} 条`)
  console.log(`回放记录: ${report.replay.length} 条`)
}

await main()
