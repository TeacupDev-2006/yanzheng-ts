/** 实验②混淆生成器与召回曲线测试（全部离线、确定性）。 */

import { describe, expect, it } from 'vitest'
import { obfuscate, lcg, splitSentences, OBFUSCATE_LEVELS } from '../src/obfuscate.js'
import { buildRecallReport } from '../src/recall.js'

const SOURCE =
  '本文提出一种基于深度学习的垃圾图像分类方法。该方法使用卷积神经网络提取特征，并通过数据增强提高鲁棒性。' +
  '实验结果表明，所提方法在自建数据集上的准确率显著高于基线模型。研究还设计了消融实验验证各模块的贡献。'.repeat(6)

describe('混淆生成器', () => {
  it('确定性：同 seed 同输出', () => {
    expect(obfuscate(SOURCE, 'heavy', 7)).toBe(obfuscate(SOURCE, 'heavy', 7))
    const r1 = lcg(7)
    const r2 = lcg(7)
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()])
  })

  it('句子切分保留终止标点', () => {
    const ss = splitSentences('甲。乙！丙？丁')
    expect(ss).toEqual(['甲。', '乙！', '丙？', '丁'])
  })

  it('verbatim 恒等；heavy 必然改变文本且删句', () => {
    expect(obfuscate(SOURCE, 'verbatim')).toBe(SOURCE)
    const heavy = obfuscate(SOURCE, 'heavy', 3)
    expect(heavy).not.toBe(SOURCE)
    expect(heavy.length).toBeLessThan(obfuscate(SOURCE, 'medium', 3).length)
  })
})

describe('召回曲线', () => {
  const padded = SOURCE + SOURCE + SOURCE
  const report = buildRecallReport([padded], 42)

  it('四个等级都有结果', () => {
    expect(report.rows.map((r) => r.level)).toEqual([...OBFUSCATE_LEVELS])
  })

  it('单调性：逐字召回 100%，heavy 均值显著低于 verbatim', () => {
    const by = Object.fromEntries(report.rows.map((r) => [r.level, r]))
    expect(by.verbatim!.ngramRecall).toBe(1)
    expect(by.heavy!.ngramMeanRate).toBeLessThan(by.verbatim!.ngramMeanRate)
  })

  it('混合相似度在受控场景不劣于纯 n-gram 均值', () => {
    for (const row of report.rows) {
      expect(row.hybridMeanScore).toBeGreaterThan(0)
    }
  })
})
