import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node24',
  // AGH 直接加载本包：全部依赖内联打包（含 typebox），插件目录零安装即可用。
  // Kind 符号经 Symbol.for 全局注册，与 AGH 侧 typebox 实例互通。
  noExternal: [/@yanzheng\//, 'pptxgenjs', 'unpdf', '@sinclair/typebox'],
})
