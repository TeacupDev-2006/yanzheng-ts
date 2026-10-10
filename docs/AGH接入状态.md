# AGH 底座接入状态（TS 重构版）

> 更新：2026-10-10。**AGH 闭环已全部打通 ✅**（规程 3.1/3.2 要求的 ≥3 连续步骤 + 执行记录均已产出）。

## 闭环验证记录（2026-10-10 实测通过）

`scripts/agh-e2e.mjs` 在真实 AGH daemon 上完成全流程：

```
STEP OK  daemon 冷启动（隔离 AGH_HOME）
STEP OK  SDK 连接 daemon（命名管道 + 服务端身份校验）
STEP OK  插件安装/信任/启用 — @yanzheng/agh-plugin@0.6.0
STEP OK  package status — desired=enabled actual=running trusted=true
STEP OK  回环 provider 夹具接入（官方验收机制，无真实模型账号）
STEP OK  ① thesis_gate 经 daemon 真实执行 — word_count=1267 passed=true（金标一致）
STEP OK  ② thesis_sections 经 daemon 真实执行 — count=19
STEP OK  ③ thesis_review 经 daemon 真实执行（含审批流） — report_id=ba48428adeac score=71 vetoed=true
STEP OK  权限审批流验证 — approvals=1
STEP OK  执行记录导出 — AGH执行记录.jsonl（67 行含工具调用）/ .html
=== AGH 闭环验证全部通过 ===
```

证据文件：`docs/AGH执行记录.jsonl`（原生 envelope）、`docs/AGH执行记录.html`（人工核查版）、
`docs/AGH执行记录.验证摘要.json`、`docs/AGH评卷报告.html`（daemon 内真实执行的评卷产物）。

## Windows 原生构建实录（已解决）

阻塞与解法（供复现）：
1. `AGNES_NODE_HEADERS=D:/ZCode/node-headers/24.21.0`（npmmirror 下载 headers+node.lib）
2. VS C++ Build Tools 安装后：`pnpm --filter @agnes/system-node build:native`（MSVC 编译 agnes-system.node）
3. `pnpm --filter @agnes/cli build:local` → `packages/cli/dist/local/agnes.mjs`
4. **ACL 坑**：daemon 私有目录校验要求 AGH_HOME 的 DACL 只含当前用户/SYSTEM——`icacls D:\ZCode\agh-home /inheritance:r /grant:r "lk202:(OI)(CI)F" /grant:r "SYSTEM:(OI)(CI)F"`
5. **SDK 管道坑**：Windows 命名管线必须带 `serverIdentity:{pid, processStartId}`（owner.json 提供）
6. **file: 来源坑**：相对解析根是 `$AGH_HOME/profiles/<profile>/`，插件副本须放入该处
7. 会话：`client.workspace.add(cwd)` 后 `client.session.new({cwd})`；审批 handler 在 new 后注册（仅 load 支持参数式）

## 闭环复跑（Windows CMD 一键脚本）

**注意：`@agnes/*` 的构建命令必须在 `D:\ZCode\agnes-harness` 目录下执行**（TS重构目录里没有这些包）；
CMD 路径一律用反斜杠（`d/ZCode/...` 会被解析成 `D:\dZCode`）。

日常复跑（已封装，CMD 直接运行）：

```bat
scripts\run-agh-e2e.cmd
```

脚本自动设置 AGH_HOME / AGNES_PROFILE / AGNES_NODE_HEADERS 并经 tsx 运行闭环
（SDK 直连 → 插件幂等装启 → 3 步工具真实执行含审批 → 执行记录导出）。

手动分步版（**CMD 纯净版**：以下代码块可直接整段粘贴；不要在 CMD 里使用 `#` 注释与 `export`）：

```bat
set "AGNES_NODE_HEADERS=D:\ZCode\node-headers\24.21.0"
cd /d D:\ZCode\agnes-harness
pnpm --filter @agnes/system-node build:native
pnpm --filter @agnes/cli build:local
```

> 再次强调：以上两步构建**已经完成**（产物在 packages\system-node\dist\native\ 与
> packages\cli\dist\local\），日常不需要重跑；复跑闭环只用 `scripts\run-agh-e2e.cmd`。

运行与验证证据（第八节）：
- 正常：`docs/AGH执行记录.jsonl`（daemon 原生 envelope，67+ 行工具调用）
- 边界/失败：三大测试套件 + 打回/降级/SSRF 拦截用例（对照清单第五节映射）


## 已完成 ✅

### 1. 插件包按现行 AGH 规范实现

`packages/agh-plugin/`（发布副本：`D:/ZCode/agh-plugins/yanzheng-thesis-review`）：

- `package.json` `agnes.plugins` 清单：`{export: "thesisReviewTools", id: "ext:yanzheng/agh-plugin", inject: ["extension"]}`
- 4 个工具原生调用 TS 引擎（`@yanzheng/core` 内联打包，零运行时依赖）：
  `thesis_gate` / `thesis_sections` / `thesis_dedup` / `thesis_review`
- 参数 schema：@sinclair/typebox（与 AGH 同款，Kind 符号经 `Symbol.for` 全局注册）
- meta 语义（对照 AGH `checkToolDef` 现行要求，`costHint`/`deferLoading` 显式声明、
  `replay` 取现行枚举 `safe|never|idempotent`）：
  - 前三者 readOnly / replay:safe / costHint:undefined / approval:never
  - `thesis_review` replay:never / costHint:{wallMs:240000} / approval:always

### 2. AGH 官方机制级校验 —— 全部通过

脚本：`scripts/agh-manifest-verify.mts`（在 agnes-harness 下以 tsx 运行）。
使用 AGH 自己的代码路径验证（同官方 `tools/public-docs/examples.test.ts` 惯用法）：

```
PASS manifest:  ext:yanzheng/agh-plugin  inject=[extension]  export=thesisReviewTools
                （AGH parseAgnesPluginEntries 官方解析器）
PASS register:  thesis_dedup / thesis_gate / thesis_review / thesis_sections; hooks=["session_start"]
PASS checkToolDef ×4（AGH extension-api 官方工具定义校验器）
PASS schema 正反例（AGH protocol validateAgainst：类型/多余字段/必填）
PASS thesis_gate execute（word_count=1267，与 Python 金标一致）
PASS thesis_sections / thesis_dedup / thesis_review execute（report_id、四团评分、报告文件落盘）
```

### 3. 闭环脚本就绪

`scripts/agh-e2e.mjs`：隔离 AGH_HOME → SDK 直连 daemon → inspect/install/trust/enable →
AGH 官方回环 provider 夹具 → 会话内连续执行 3 步工具（含审批流）→ `agnes export` 导出执行记录。

## 原生构建阻塞（已解决 ✅，2026-10-10）

~~Windows 下 AGH daemon 强制要求 `@agnes/system-node` 原生模块~~——已编译完成：
`packages/system-node/dist/native/agnes-system.node`（MSVC/242KB，headers 取自
`D:/ZCode/node-headers/24.21.0`），`packages/cli/dist/local/agnes.mjs` 分发入口已产出。
过程中排掉的 Windows 坑（ACL 私有目录校验 / SDK 管线 serverIdentity / file: 解析根 /
workspace 注册 / 审批 handler 时机 / config revision）实录见上文「闭环验证记录」。

日常复跑闭环：`scripts\run-agh-e2e.cmd`（CMD 一键，幂等）。

## 真实模型模式（AGNES_REAL=1，已实现，待 AGH 上游修复后复跑）

`scripts\agh-e2e.mjs` 支持 `AGNES_REAL=1`：跳过回环夹具，经 AGH 内置 `agnes-ai` provider 接入
赛事真实端点（`https://api.agnes-ai.cn/v1`，key 经环境变量传入不落脚本），AI 助手自主规划
连续调用三工具、评审用真实模型双重执行。

当前状态（2026-10-10）：端点/模型目录校验通过、config 保存成功，但 daemon 内模型调用报
`TURN_ERROR / TRANSPORT / status=?`（AGH 内部 agnes-ai 调用栈问题——同机同 key 的
CLI/Web/裸 fetch 全部 200 正常，含流式；AGH 为 developer preview）。已具备反馈条件：
携参赛编号 U297 在参赛群向技术客服反馈（勿发 key）。AGH 上游修复后 `run-agh-e2e.cmd`
前 `set AGNES_REAL=1` 即可复跑真实模型闭环。

当前有效证据组合（均真实）：
1. AGH 闭环 + 执行记录（回环 provider，官方验收机制）✅
2. Agnes 模型真实评卷：`docs/Agnes真实评卷报告.html`（agnes-3.0-flash 18 次调用 / 87,941
   tokens / 404.8s / 59.7 分否决——与 DeepSeek 独立结论互相印证）✅

## 合规证据对照（规程 3.1/3.2）——**全部达成 ✅**

| 要求 | 状态 | 证据 |
|---|---|---|
| 以 AGH 为运行底座 | ✅ 已验证 | AGH 官方解析器/校验器全 PASS（agh-manifest-verify）+ daemon 内 `actual=running trusted=true` |
| 经 AGH ≥3 连续步骤 | ✅ **已实测** | thesis_gate → thesis_sections → thesis_review 经 daemon 连续真实执行（含审批流），详见上文闭环记录 |
| AGH 执行记录 | ✅ **已导出** | `docs/AGH执行记录.jsonl`（411KB，84 行工具调用事件）+ `.html`（人工核查版），daemon 原生 envelope |
| 第三方申报 | ✅ | STATEMENT.md：Agnes Harness（AGH）运行底座 + DeepSeek 模型可切换 Agnes |

可选增强：用赛事发放的 Agnes key 替换回环 provider 重跑一遍（`scripts\run-agh-e2e.cmd`
内 provider 段改为真实端点），证据等级再升一档。

