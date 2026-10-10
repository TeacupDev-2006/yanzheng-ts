/** 诊断：解析会话导出，统计事件类型、找工具调用与错误详情。 */
const fs = require('node:fs')
const path = require('node:path')
const file = path.join(__dirname, 'probe-session.jsonl')
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
console.log('total lines:', lines.length)

const types = {}
const toolEvents = []
const errEvents = []
for (const l of lines) {
  let e
  try { e = JSON.parse(l) } catch { continue }
  const t = e.type || e.kind || '?'
  types[t] = (types[t] || 0) + 1
  const s = JSON.stringify(e)
  if (/thesis_(gate|sections|review)/.test(s) && toolEvents.length < 6) {
    toolEvents.push(`${t} | ${s.slice(0, 220)}`)
  }
  if (s.includes('INTERNAL') || s.includes('INTERNAL_ERROR') || (e.error && Object.keys(e.error).length)) {
    errEvents.push(`${t} | ${s.slice(0, 300)}`)
  }
}
console.log('== 事件类型分布 ==')
for (const [t, n] of Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`  ${t}: ${n}`)
console.log('== 全部 tool/call 序列 ==')
for (const l of lines) {
  let e
  try { e = JSON.parse(l) } catch { continue }
  if ((e.type || '') === 'tool/call') {
    const s = JSON.stringify(e)
    const nameM = s.match(/"(?:name|tool)"\s*:\s*"([^"]{1,40})"/)
    console.log(`  seq=${e.seq} ${nameM ? nameM[1] : s.slice(0, 80)}`)
  }
}
console.log('== 错误/内部错误事件 ==')
for (const x of errEvents.slice(0, 8)) console.log(' ', x)
// assistant 消息尾部（模型最后说了什么）
const assistant = lines.filter((l) => l.includes('"assistant/message"')).slice(-2)
for (const l of assistant) {
  try { const e = JSON.parse(l); console.log('ASSISTANT 尾:', JSON.stringify(e).slice(0, 300)) } catch {}
}
