# AGH 底座接入状态（TS 重构版）

> 更新：2026-10-06。对应规程 3.1/3.2「AGH 闭环」要求（评审权重 20 分）。

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

## 待完成 ⏳（仅剩 Windows 原生构建）

**唯一阻塞**：Windows 下 AGH daemon 强制要求 `@agnes/system-node` 原生模块
（`agnes-system.node`，私有 DACL 文件锁；源码 `packages/daemon/src/supervisor/mutation-lock.ts`
win32 分支无 JS 回退）。构建需 MSVC（VS C++ Build Tools）。

已就绪的材料：
- Node 24.21.0 headers + node.lib：`D:/ZCode/node-headers/24.21.0/`（npmmirror 镜像下载，含 x64/win-x64 两份 node.lib）
- AGH 仓库已构建（packages/web 等全部 TS 包）；仅缺 native + `packages/cli/dist/local/agnes.mjs`
- VS Build Tools 安装已发起（等待 UAC 确认后完成）

完成后两条命令解锁：

```bash
export AGNES_NODE_HEADERS=D:/ZCode/node-headers/24.21.0
cd /d/ZCode/agnes-harness
pnpm --filter @agnes/system-node build:native
pnpm --filter @agnes/cli build:local
node "/d/ZCode/2026年江苏省AI+科学与工程创新实践黑客松 TS重构/scripts/agh-e2e.mjs"
```

> 备选（零编译路径）：Linux/WSL 下 AGH 锁为纯 fs 实现，`pnpm build:local` 只需 cc + headers。

## 合规证据对照（规程 3.1/3.2）

| 要求 | 状态 | 证据 |
|---|---|---|
| 以 AGH 为运行底座 | ✅ 机制级已验证 | agh-manifest-verify 输出（AGH 官方解析器/校验器全部 PASS） |
| 经 AGH ≥3 连续步骤 | ⏳ daemon 原生构建后 | agh-e2e 自动生成 docs/AGH执行记录.jsonl/.html |
| AGH 执行记录 | ⏳ 同上 | 导出脚本已就绪 |
| 第三方申报 | ✅ | STATEMENT.md：Agnes Harness（AGH）运行底座 + DeepSeek 模型可切换 Agnes |
