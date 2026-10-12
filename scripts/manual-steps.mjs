/**
 * 无 AGH 的手动编排演示（视频对比镜头用）：开发者手动调用三个能力，
 * 手动传参、无审批、无执行留痕——与 AGH 会话内 AI 自主编排形成对照。
 * 运行：node scripts/manual-steps.mjs（在项目根；③ 完整评卷约 7 分钟需真实 key）
 */
import { readFile } from 'node:fs/promises'
import { runGate, splitSections, reviewPaper } from '../packages/core/dist/index.js'

const text = await readFile('testdata/demo_paper.txt', 'utf8')

console.log('① 手动门检（人工传参）:')
console.log('  ', JSON.stringify(runGate({ text, minWords: 1000 })).slice(0, 150))

const sections = splitSections(text)
console.log('② 手动切分:', sections.length, '个章节')

console.log('③ 手动评卷（约 7 分钟，需 set YANZHENG_API_KEY 后运行）...')
const report = await reviewPaper({ text, minWords: 1000 })
console.log('  总分:', report.finalScore, '| 否决:', report.vetoed)
console.log('  注意：无权限审批、无执行留痕——流程结束后什么都没留下')
