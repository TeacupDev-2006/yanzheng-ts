/** 诊断：最小会话 prompt 探针（真实 Agnes 模型）。prompt 后导出该 session 供检查。 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { createClient, memoryJournal } = await import(
  pathToFileURL('D:/ZCode/agnes-harness/packages/sdk/src/index.node.ts').href
)
const HOME = 'D:/ZCode/agh-home'
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
const cwd = 'D:/ZCode/agh-plugins'
await client.workspace.add(cwd).catch((e) => console.log('workspace.add:', e.message))
const session = await client.session.new({ cwd })
const r = await session
  .prompt('请只回复两个字：正常', { signal: AbortSignal.timeout(60000) })
  .then(() => 'ok')
  .catch((e) => `REJECTED ${e.code} ${e.message} data=${JSON.stringify(e.data ?? null).slice(0, 400)}`)
console.log('prompt:', r)
const sessionId = (await client.session.list({})).items[0]?.sessionId
console.log('sessionId:', sessionId)
await session.close?.().catch(() => {})
await client.close().catch(() => {})
