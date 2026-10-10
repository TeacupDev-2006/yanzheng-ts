/** 诊断：最小 inspect 调用，打印完整错误。 */
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
const common = { profile: 'local-dev', clientId: await client.clientId() }
try {
  const receipt = await client.packages.inspect({
    ...common,
    commandId: `probe-${Date.now()}`,
    source: { type: 'file', ref: 'file:./yanzheng-thesis-review' },
  })
  console.log('receipt ok:', receipt.operationId)
  for (let i = 0; i < 40; i++) {
    const st = await client.packages.operation.get({ profile: 'local-dev', operationId: receipt.operationId })
    if (st.state === 'failed' || st.state === 'cancelled') {
      console.log('FAILED:', JSON.stringify(st, null, 2).slice(0, 1200))
      break
    }
    if (st.state === 'completed' || st.state === 'rolled-back') {
      console.log('COMPLETED:', JSON.stringify(st).slice(0, 400))
      break
    }
    await new Promise((d) => setTimeout(d, 300))
  }
} catch (e) {
  console.log('inspect error:', e.name, e.code ?? e.data?.code, e.message)
  console.log('data:', JSON.stringify(e.data ?? null).slice(0, 500))
}
await client.close().catch(() => {})
