---
name: thesis-review-panel
description: 研证：毕业论文评卷团 Agent（TS 版，AGH 原生）——对本科毕业论文做高考式多评卷员独立打分、分差仲裁、作假一票否决审查，生成含修改路线图的 HTML/PPT 报告。当用户需要评审、打分、查作假、生成修改建议或对比论文质量时使用。
---

# 毕业论文评卷团插件（研证 yanzheng · TS 版）

模拟高考作文评卷机制的本科毕业论文质量审查工具：4 个评审团 13 名评卷员独立打分（内容 40 / 结构 30 / 语言 15 / 规范 15），团内分差 >15% 触发团长复核，作假疑点由总仲裁复核证据链、成立则一票否决。

本技能随 AGH 插件 `@yanzheng/agh-plugin` 分发，工具链已原生注册到 AGH 底座（TypeScript 单运行时，无 Python 依赖）。

## AGH 工具

| 工具 | 语义 | 副作用 |
|---|---|---|
| `thesis_gate` | 硬性门检：字数（中文1字/英文1词）、必备章节、警告项、分块查重率 | 只读 |
| `thesis_sections` | 按章节标题（第X章/N.N/一、）切分文本 | 只读 |
| `thesis_dedup` | 分块查重取证：论文块 vs 语料块最佳匹配（相似度+摘录） | 只读 |
| `thesis_review` | 全流程评卷：13 员并行 → 两级仲裁 → 作假否决 → HTML/PPT 报告 | 写报告文件，需批准 |

## 工作流

1. 确认论文路径（.pdf/.txt/.md）与可选查重语料目录
2. 先跑 `thesis_gate`：不通过即打回，把明细反馈给用户，流程终止
3. 通过后跑 `thesis_review`（写 HTML 报告 + 可选 PPT），经 AGH 批准后执行
4. 打开单文件 HTML 报告向用户解读：总分与等级 → 四团雷达图 → 修改优先级路线图 → 作假审查专区 → 各团评分明细与仲裁记录回放

## 解读要点

- 门检硬性项：查重率 <10%、字数 ≥1 万、必备章节；不过直接打回（报告只含打回清单）
- 警告项（不打回）：关键词/英文摘要/目录缺失、参考文献 <8 条、疑似扫描件
- 无查重语料时，重复检测评卷员自动回避（仲裁日志标注 abstain），非满分
- 低置信度（<0.6）评分标红"建议人工复核"；评卷员失败自动降级、仲裁失败降级取均值
- 成本：报告尾注各模型 token 用量与耗时（1 万字论文约 14 万 tokens / 2~4 分钟）

## 模型配置（环境变量）

- `YANZHENG_API_KEY`：DeepSeek/Agnes API key；缺省为演示模式（确定性 mock）
- `YANZHENG_LLM_BASE_URL`：OpenAI 兼容端点（赛事可切 Agnes 模型）
- `YANZHENG_MODEL_JUDGE`：评卷档（默认 `deepseek-flash`，非思考）
- `YANZHENG_MODEL_ARBITER`：仲裁档（默认 `deepseek-v4-pro`，思考模式）

## 注意事项

- DeepSeek 模型名：评卷 `deepseek-flash` / 仲裁 `deepseek-v4-pro`（旧名 deepseek-chat/reasoner 已废弃）
- `online` 需网络（Crossref / OpenAlex；离线自动降级并在证据中注明）
- 出站请求全部经 SSRF 守卫（仅 http/https 公网地址）
- 详细机制见仓库 `docs/README` 与原项目 `方案.md`
