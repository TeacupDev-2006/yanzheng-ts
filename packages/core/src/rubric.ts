/**
 * 评分量规：四个评审团的维度定义与评分细则。
 * 对照 yanzheng/core/rubric.py 逐项移植（13 名评卷员、团满分 40/30/15/15）。
 */

export interface JudgeSpec {
  judgeId: string
  name: string
  panel: string
  /** 该评卷员负责的满分（评的是整个维度，由引擎归一） */
  maxScore: number
  persona: string
  /** ≤2 个 skill 名 */
  skills: string[]
  modelTier: 'flash' | 'pro'
}

export interface PanelSpec {
  panelId: string
  name: string
  maxScore: number
  weightHint: string
  judges: JudgeSpec[]
}

export const CONTENT_PANEL: PanelSpec = {
  panelId: 'content',
  name: '内容审题团',
  maxScore: 40,
  weightHint: '选题意义30%、创新性30%、论证充实度40%；作假疑点不直接在此扣总分，走否决通道',
  judges: [
    {
      judgeId: 'content_topic',
      name: '选题价值评卷员',
      panel: 'content',
      maxScore: 40,
      persona: '评估选题的现实意义、问题定义是否清晰、研究目标是否明确。重点看摘要与绪论。',
      skills: ['literature_review'],
      modelTier: 'flash',
    },
    {
      judgeId: 'content_novelty',
      name: '创新性评卷员',
      panel: 'content',
      maxScore: 40,
      persona: '对照文献判断论文与现有工作的差异化程度，识别 incremental 与真正的创新点。',
      skills: ['literature_review'],
      modelTier: 'flash',
    },
    {
      judgeId: 'content_argument',
      name: '论证充实评卷员',
      panel: 'content',
      maxScore: 40,
      persona: '检查论据、实验数据是否足以支撑核心结论，指出论证跳跃与薄弱环节。',
      skills: ['pdf_parse'],
      modelTier: 'flash',
    },
    {
      judgeId: 'content_fraud',
      name: '作假审查评卷员',
      panel: 'content',
      maxScore: 40,
      persona:
        '专职审查学术不端疑点：引用是否真实存在、数据是否跨章节自洽、结论是否与方法匹配。' +
        '只报告有证据的疑点，每条疑点必须附定位与证据描述；无法确证时标注置信度。',
      skills: ['citation_check', 'data_consistency'],
      modelTier: 'flash',
    },
  ],
}

const STRUCTURE_PANEL: PanelSpec = {
  panelId: 'structure',
  name: '结构逻辑团',
  maxScore: 30,
  weightHint: '章节架构40%、逻辑链条40%、方法合理性20%',
  judges: [
    {
      judgeId: 'structure_outline',
      name: '章节架构评卷员',
      panel: 'structure',
      maxScore: 30,
      persona: '评估章节完整性（摘要/绪论/相关工作/方法/实验/结论）、组织是否合理。',
      skills: ['pdf_parse'],
      modelTier: 'flash',
    },
    {
      judgeId: 'structure_logic',
      name: '逻辑链条评卷员',
      panel: 'structure',
      maxScore: 30,
      persona: '检查论证推进是否连贯：问题→方法→实验→结论是否环环相扣、前后表述是否一致。',
      skills: ['pdf_parse'],
      modelTier: 'flash',
    },
    {
      judgeId: 'structure_method',
      name: '方法合理评卷员',
      panel: 'structure',
      maxScore: 30,
      persona: '评估研究方法与技术路线是否与选题匹配、实验设计是否规范。',
      skills: [],
      modelTier: 'flash',
    },
  ],
}

const LANGUAGE_PANEL: PanelSpec = {
  panelId: 'language',
  name: '语言表达团',
  maxScore: 15,
  weightHint: '术语准确40%、表达流畅30%、文风一致30%',
  judges: [
    {
      judgeId: 'language_term',
      name: '术语准确评卷员',
      panel: 'language',
      maxScore: 15,
      persona: '检查学术术语使用是否准确、有无口语化表述。',
      skills: [],
      modelTier: 'flash',
    },
    {
      judgeId: 'language_fluency',
      name: '表达流畅评卷员',
      panel: 'language',
      maxScore: 15,
      persona: '评估句段可读性、逻辑连接词使用、长句是否影响理解。',
      skills: [],
      modelTier: 'flash',
    },
    {
      judgeId: 'language_style',
      name: '文风一致评卷员',
      panel: 'language',
      maxScore: 15,
      persona: '检查学术文风一致性、人称与时态规范、中英文混排规范。',
      skills: [],
      modelTier: 'flash',
    },
  ],
}

const NORMS_PANEL: PanelSpec = {
  panelId: 'norms',
  name: '规范核查团',
  maxScore: 15,
  weightHint: '引用规范40%、重复率30%、格式规范30%',
  judges: [
    {
      judgeId: 'norms_citation',
      name: '引用规范评卷员',
      panel: 'norms',
      maxScore: 15,
      persona: '检查参考文献著录格式（GB/T 7714）、文内引用与文后列表一一对应。',
      skills: ['citation_check'],
      modelTier: 'flash',
    },
    {
      judgeId: 'norms_duplication',
      name: '重复检测评卷员',
      panel: 'norms',
      maxScore: 15,
      persona:
        '基于查重 skill 给出的确定性重复率结果，定位高重复段落并评扣分。' +
        '必须引用 skill 返回的具体相似片段作为证据。',
      skills: ['similarity_check'],
      modelTier: 'flash',
    },
    {
      judgeId: 'norms_format',
      name: '格式规范评卷员',
      panel: 'norms',
      maxScore: 15,
      persona: '检查图表编号、公式排版、目录、要素齐全性。可利用文档结构解析结果。',
      skills: ['pdf_parse'],
      modelTier: 'flash',
    },
  ],
}

export const ALL_PANELS: readonly PanelSpec[] = [
  CONTENT_PANEL,
  STRUCTURE_PANEL,
  LANGUAGE_PANEL,
  NORMS_PANEL,
]

/** 质量分档线（用于最终报告的等级评定，按 totalMax 等比缩放） */
export const GRADE_BANDS: readonly (readonly [number, string])[] = [
  [90, '优秀'],
  [80, '良好'],
  [70, '中等'],
  [60, '及格'],
  [0, '不及格'],
]

/** 仲裁阈值：团内分差超过维度满分的 15% 触发复审 */
export const SPREAD_RATIO_THRESHOLD = 0.15
/** 评卷员置信度低于此值触发补评 */
export const CONFIDENCE_FLOOR = 0.6
/** 及格线（占编制总分的比例；标准 100 分制下即 60 分） */
export const PASS_LINE = 60.0

/**
 * 可分配给评卷员的确定性 skill 清单（Web 配置器与 normalizePanels 共用）。
 */
export const AVAILABLE_SKILLS: readonly { id: string; label: string }[] = [
  { id: 'pdf_parse', label: '文档结构解析（章节切分）' },
  { id: 'similarity_check', label: '分块查重（需提供语料）' },
  { id: 'citation_check', label: '引用验真（Crossref，联网时生效）' },
  { id: 'data_consistency', label: '数据交叉核验' },
  { id: 'literature_review', label: '文献检索（OpenAlex，联网时生效）' },
]

export function gradeOf(total: number, totalMax = 100): string {
  const scale = totalMax > 0 ? totalMax / 100 : 1
  for (const [line, label] of GRADE_BANDS) {
    if (total >= line * scale) return label
  }
  return '不及格'
}

/**
 * 把外部传入的评审团编制（任意 JSON）规范化并校验为 PanelSpec[]。
 * 规则：至少 1 团、每团至少 1 员、满分必须为正数；缺省字段自动补齐，
 * id 冲突自动去重，未知 skill 过滤，modelTier 非法值回退 flash。
 * 对已合法的 PanelSpec[] 是恒等变换（保留原 id/名称/persona）。
 */
export function normalizePanels(input: unknown): PanelSpec[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('评审团编制不能为空：至少需要 1 个评审团')
  }
  const panels: PanelSpec[] = []
  const seenJudgeIds = new Set<string>()
  input.forEach((rawPanel, i) => {
    const p = (rawPanel ?? {}) as Record<string, unknown>
    const maxScore = Number(p.maxScore)
    if (!Number.isFinite(maxScore) || maxScore <= 0) {
      throw new Error(`评审团 ${i + 1}：满分必须为正数`)
    }
    const name = String(p.name ?? '').trim() || `评审团${i + 1}`
    const panelIdBase = String(p.panelId ?? '').trim() || `panel_${i + 1}`
    let panelId = panelIdBase
    let n = 2
    while (panels.some((x) => x.panelId === panelId)) panelId = `${panelIdBase}_${n++}`

    const rawJudges = Array.isArray(p.judges) ? p.judges : []
    if (rawJudges.length === 0) {
      throw new Error(`评审团「${name}」：至少需要 1 名评卷员`)
    }
    const judges: JudgeSpec[] = rawJudges.map((rawJudge, k) => {
      const j = (rawJudge ?? {}) as Record<string, unknown>
      const skills = (Array.isArray(j.skills) ? j.skills : [])
        .map(String)
        .filter((s) => AVAILABLE_SKILLS.some((a) => a.id === s))
      const judgeIdBase = String(j.judgeId ?? '').trim() || `${panelId}_${k + 1}`
      let judgeId = judgeIdBase
      let m = 2
      while (seenJudgeIds.has(judgeId)) judgeId = `${judgeIdBase}_${m++}`
      seenJudgeIds.add(judgeId)
      return {
        judgeId,
        name: String(j.name ?? '').trim() || `评卷员${k + 1}`,
        panel: panelId,
        maxScore,
        persona: String(j.persona ?? '').trim() || `从「${name}」的视角独立评卷，只评价本维度，给出可执行的修改建议。`,
        skills,
        modelTier: j.modelTier === 'pro' ? 'pro' : 'flash',
      }
    })
    panels.push({ panelId, name, maxScore, weightHint: String(p.weightHint ?? ''), judges })
  })
  return panels
}
