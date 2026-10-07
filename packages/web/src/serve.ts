/** Web 服务启动入口：pnpm --filter @yanzheng/web start（默认 8600 端口，对齐原 uvicorn 用法）。 */

import { serve } from '@hono/node-server'
import { createApp } from './app.js'

const port = Number.parseInt(process.env.PORT ?? '8600', 10)
const app = createApp()
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`研证 Web 已启动: http://127.0.0.1:${info.port}  (mode=${process.env.DEEPSEEK_API_KEY ? 'real' : 'demo'})`)
})
