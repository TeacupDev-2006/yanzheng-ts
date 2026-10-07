# 研证 · 毕业论文评卷团 Agent（TS 版）

> TypeScript 全量重构版 —— 原生运行于 **AGH（Agnes Harness）底座**，单一 Node 运行时，无 Python 依赖。

模拟高考评卷机制的本科毕业论文质量审查多 Agent 系统：

```
论文 → ① 硬性门检（字数≥1万 / 分块查重<10% / 必备章节，纯确定性程序，不过打回）
     → ② 4 个评审团 13 名评卷员并行独立打分（内容40 / 结构30 / 语言15 / 规范15，互相不可见）
     → ③ 团内仲裁（分差>15% 触发团长(pro)复核、剔除离群评分）
     → ④ 总仲裁（合成总分 + 作假证据链复核一票否决 + 修改优先级路线图）
     → ⑤ 单文件 HTML 交互报告（文学期刊风）+ 可选 PPT 导出
```

LLM 内核为 OpenAI 兼容接口（默认 DeepSeek：评卷 `deepseek-flash` 非思考 / 仲裁 `deepseek-v4-pro` 思考）；
**无 API key 时全链路确定性 mock 可跑**。三种形态：CLI / Web / AGH 插件。

## 目录结构

```
packages/
  core/        @yanzheng/core —— 评卷引擎（门检/量规/评卷员/两级仲裁/技能/报告）
  cli/         @yanzheng/cli  —— 命令行形态（yanzheng <paper> [选项]）
  web/         @yanzheng/web  —— Hono Web 形态（/ /review /health）
  agh-plugin/  @yanzheng/agh-plugin —— AGH 底座插件（4 个工具原生注册）
testdata/      测试数据 + Python 重算金标（golden.json）
scripts/       gen_golden.py（金标生成）/ agh-manifest-verify.mts / agh-e2e.mjs（AGH 闭环）
docs/          操作手册 / AGH 接入状态 / 执行记录
```

## 快速开始

> 提示：以下命令块只含命令、不含注释，可直接整段粘贴。
> CMD 不支持 `#` 注释与 `export`；设环境变量用 `set`（CMD）或 `$env:`（PowerShell）。

```bat
pnpm install
pnpm -r build
pnpm -r test
pnpm journeys
```

测试规模：vitest 95 项（core 66 + web 17 + agh-plugin 12，含 Python 金标等价）+ CLI 真进程旅程 32 项断言。

**演示模式**（无 key，约 3 秒：13 员评卷 + 否决通路，产出 `demo_评卷报告.html`）：

```bat
pnpm demo
```

**Web 形态**（浏览器打开 http://127.0.0.1:8600 投稿）：

```bat
pnpm web
```

投稿页内置**评卷委员会配置器**：
- **自选 AI（12 家主流厂商预设）**：DeepSeek / OpenAI / Anthropic(Claude) / Google Gemini / Kimi(月之暗面) / Qwen(阿里云百炼) / GLM(智谱) / xAI(Grok) / MiniMax / OpenRouter(聚合) / Agnes 赛事端点 / 自定义 OpenAI 兼容端点。选预设自动填官方兼容端点与推荐型号，API key 自备（留空 = 演示模式）；DeepSeek 私有 `thinking` 参数按预设自动适配，不会误发给第三方端点
- **具体型号选择**：评卷档/仲裁档输入框自带型号下拉（各家常用型号 + 中文说明）；可「从端点拉取模型列表」取回真实型号（仅限公网端点，SSRF 守卫；OpenRouter 数百个），也可手输任意型号
- **自定义评审团编制**：可添加/删除整个评审团，也可在每个团内添加/删除评卷员；每名评卷员可编辑名称与评卷视角（persona）、勾选确定性技能（文档解析/查重/引用验真/数据核验/文献检索）、选择模型档（flash=评卷档 / pro=仲裁档）
- 及格线（总分 60%）与优秀/良好/中等/及格分档随编制总分**等比缩放**；「恢复默认编制」一键回到标准 4 团 13 员

**CLI 评卷**（无 key 自动进演示 mock；换真实论文路径即可）：

```bat
node packages\cli\bin\yanzheng.mjs testdata\paper_good.md --corpus testdata\corpus --out 评卷报告.html --ppt 评卷报告.pptx
```

**真实评卷**（DeepSeek 或 Agnes 赛事模型）：

```bat
set YANZHENG_API_KEY=sk-你的key
node packages\cli\bin\yanzheng.mjs 论文.pdf --corpus 语料目录 --online --out 评卷报告.html
```

PowerShell 设 key 用 `$env:YANZHENG_API_KEY="sk-你的key"`；Git Bash 用 `export YANZHENG_API_KEY=sk-你的key`。

## AGH 底座接入

插件包 `@yanzheng/agh-plugin` 按 AGH 官方规范（`agnes.plugins` 清单 + `inject:['extension']` +
TypeBox schema + meta 语义声明）注册 4 个工具，**直接内联调用 TS 引擎**（旧版的 Python 子进程桥已移除）：

| 工具 | 语义 | meta |
|---|---|---|
| `thesis_gate` | 硬性门检（字数/必备章节/警告项/分块查重率） | readOnly / replay:safe / approval:never |
| `thesis_sections` | 章节切分（第X章 / N.N / 一、） | 同上 |
| `thesis_dedup` | 分块查重取证（块级最佳匹配 + 摘录） | 同上 |
| `thesis_review` | 全流程评卷 → HTML/PPT 报告 | replay:never / approval:always / costHint |

验证状态见 [docs/AGH接入状态.md](docs/AGH接入状态.md)。

## 确定性等价保证

`packages/core/src/gates/gates.ts` 与原 Python `yanzheng/core/gates.py` 逐函数移植，
由 `testdata/golden.json`（原实现重算）逐字段断言：字数 / 格式 / 警告 / 查重率浮点逐位一致。
空白字符语义（Python `\s` 全集）与切片边界均有对照处理（`src/skills/ws.ts`）。

## 环境变量

| 变量 | 用途 |
|---|---|
| `YANZHENG_API_KEY` / `DEEPSEEK_API_KEY` | LLM key（均无 → 确定性 mock 模式） |
| `YANZHENG_LLM_BASE_URL` | OpenAI 兼容端点（赛事可切 Agnes 模型） |
| `YANZHENG_MODEL_JUDGE` / `YANZHENG_MODEL_ARBITER` | 评卷档 / 仲裁档模型名 |

详细用法见 [docs/操作手册.md](docs/操作手册.md)。上游项目与设计背景见原仓库
`2026年江苏省AI+科学与工程创新实践黑客松`（Python 版 v0.5）。
