/** 最小合法 PDF 夹具（单页 Helvetica 多行英文文本，正确 xref）——供 Web 用户旅程测试复用。 */

export function buildPdfTextFixture(text: string): Buffer {
  // 按词边界折行（每行 ≤72 字符），逐行一个 Tj —— 贴近真实 PDF 的文本结构
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const w of words) {
    if (current.length + w.length + 1 > 72) {
      lines.push(current)
      current = w
    } else {
      current = current ? `${current} ${w}` : w
    }
  }
  if (current) lines.push(current)

  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const content = lines
    .map((line, i) => `BT /F1 12 Tf 72 ${720 - i * 14} Td (${esc(line)}) Tj ET`)
    .join('\n')
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${Buffer.byteLength(content, 'latin1')}>>\nstream\n${content}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefPos = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}
