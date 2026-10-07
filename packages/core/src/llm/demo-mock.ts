/**
 * 演示模式的确定性 mock（对照 tests/demo_run.py 的 mock_llm）：
 * 按评卷员 id 生成固定评分与扣分点，演示否决通路与团长复核均值，不消耗 API 费用。
 */

import type { ChatMessage, MockFn } from './client.js'

interface MockDeduction {
  severity: string
  location: string
  description: string
  suggestion: string
  deduction: number
}

const BASE: Record<string, { score: number; conf: number; deds: MockDeduction[] }> = {
  content_topic: { score: 31, conf: 0.9, deds: [{ severity: '轻微', location: '第一章 1.2', description: '研究现状综述偏泛，未引用近三年对比工作', suggestion: '补充2024-2025年相关系统对比', deduction: 2 }] },
  content_novelty: { score: 26, conf: 0.85, deds: [{ severity: '较重', location: '第一章 1.3', description: '创新点表述与现状区分度不足', suggestion: '明确与现有校园分类系统的差异点', deduction: 5 }] },
  content_argument: { score: 24, conf: 0.8, deds: [{ severity: '较重', location: '第五章 5.3', description: '消融实验仅两项，未覆盖关键组件', suggestion: '补充识别服务端响应时延的消融', deduction: 4 }] },
  content_fraud: { score: 20, conf: 0.95, deds: [{ severity: '严重', location: '摘要/第五章 5.2', description: '摘要准确率95.2%与实验89.3%不一致', suggestion: '统一数据口径', deduction: 6 }] },
  structure_outline: { score: 24, conf: 0.9, deds: [{ severity: '轻微', location: '第二章', description: '需求分析缺少用例图', suggestion: '补充UML用例图', deduction: 1 }] },
  structure_logic: { score: 22, conf: 0.85, deds: [{ severity: '较重', location: '第三章 3.2', description: '方法声称纯传统图像处理但结果含深度学习指标，逻辑断裂', suggestion: '在方法章明确模型选型', deduction: 5 }] },
  structure_method: { score: 21, conf: 0.8, deds: [{ severity: '轻微', location: '第四章 4.2', description: '7:1:2划分未说明随机种子', suggestion: '补充划分细节', deduction: 2 }] },
  language_term: { score: 12, conf: 0.9, deds: [{ severity: '轻微', location: '全文', description: "'小程序'与'移动端应用'混用", suggestion: '统一术语', deduction: 1 }] },
  language_fluency: { score: 11, conf: 0.85, deds: [{ severity: '轻微', location: '第五章 5.2', description: '结果罗列缺少解读句', suggestion: '每段数据后补一句结论', deduction: 2 }] },
  language_style: { score: 12, conf: 0.9, deds: [] },
  norms_citation: { score: 10, conf: 0.95, deds: [{ severity: '严重', location: '参考文献[2]', description: 'Crossref无命中，疑似捏造文献', suggestion: '核实或删除该条目', deduction: 4 }] },
  norms_duplication: { score: 13, conf: 0.95, deds: [{ severity: '轻微', location: '第一章', description: '与综述文本存在模板化表述', suggestion: '改写相关段落', deduction: 1 }] },
  norms_format: { score: 12, conf: 0.9, deds: [{ severity: '轻微', location: '图表', description: '图3-2无编号引用', suggestion: '补齐图表交叉引用', deduction: 1 }] },
}

export const demoMockLLM: MockFn = (messages: ChatMessage[], _responseJson: boolean): string => {
  const text = messages.map((m) => m.content ?? '').join('\n')
  let marker = ''
  if (text.includes('MOCK_INSTRUCTION:')) {
    marker = text.split('MOCK_INSTRUCTION:', 2)[1]!.trim().split('\n')[0]!.trim()
  }

  if (marker === 'chief_veto') {
    // 总仲裁：证据链完整 → 否决成立（演示否决通路）
    return JSON.stringify({
      veto: true,
      veto_reasons: [
        '摘要与实验章节数据矛盾（95.2% vs 89.3%），证据定位明确',
        '参考文献[2]经 Crossref 检索无命中且标题查无实据',
      ],
      downgrade_to_deduction: false,
      reason: '两处严重疑点证据链完整，裁定作假成立。',
    })
  }

  if (marker.startsWith('panel_arb_')) {
    // 团长复核：返回团内评分均值（从注入的详情 JSON 中提取）
    const scores = [...text.matchAll(/"score":\s*([\d.]+)/g)].map((m) => Number.parseFloat(m[1]!))
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 20.0
    return JSON.stringify({
      final_score: avg,
      drop_outlier: null,
      reason: '三方评分分歧主要源于对评定标准理解不同，复核后取均值。',
    })
  }

  // 评卷员：按 id 生成固定评分表
  const entry = BASE[marker]
  if (!entry) {
    return JSON.stringify({ score: 20, confidence: 0.7, deductions: [] })
  }

  let fraud: Record<string, unknown>[] = []
  if (marker === 'content_fraud') {
    fraud = [
      {
        fraud_type: '数据不一致',
        location: '摘要 vs 第五章5.2',
        evidence: '摘要称准确率95.2%，实验章节为89.3%，同一指标两处表述矛盾',
        severity: '严重',
      },
      {
        fraud_type: '结果与方法矛盾',
        location: '第三章3.2 vs 第五章',
        evidence: '方法章声称仅用传统图像处理，实验出现F1等深度学习模型指标',
        severity: '较重',
      },
    ]
  }
  if (marker === 'norms_citation') {
    fraud = [
      {
        fraud_type: '引用捏造',
        location: '参考文献[2]',
        evidence: 'citation_check skill Crossref检索无命中，且软学报卷期号与实际刊期不符',
        severity: '严重',
      },
    ]
  }

  return JSON.stringify({
    score: entry.score,
    confidence: entry.conf,
    deductions: entry.deds,
    fraud_findings: fraud,
    evidence: [`mock:${marker}`],
  })
}
