/** 诊断：逐步调用 agnes-system.node 的目录保护函数，定位失败点。 */
const native = require('D:/ZCode/agnes-harness/packages/system-node/dist/native/agnes-system.node')
const fs = require('node:fs')

console.log('exports:', Object.keys(native).join(', '))

const dir = 'D:\\ZCode\\agh-native-probe\\data'
fs.mkdirSync(dir, { recursive: true })
console.log('dir created')

const step = (name, fn) => {
  try {
    const r = fn()
    console.log(`OK   ${name}:`, typeof r === 'boolean' ? r : typeof r)
  } catch (e) {
    console.log(`FAIL ${name}:`, e.message)
  }
}

if (native.protectPrivateDirectory) step('protectPrivateDirectory', () => native.protectPrivateDirectory(dir))
if (native.hasPrivateDacl) step('hasPrivateDacl', () => native.hasPrivateDacl(dir))
if (native.createPrivateFile) {
  step('createPrivateFile', () => {
    const r = native.createPrivateFile(dir + '\\probe.lock')
    fs.writeFileSync(dir + '\\probe.lock', '')
    return r
  })
}
