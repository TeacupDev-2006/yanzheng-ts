# AGH 插件安装指南（研证 → 官方 AGH）

> 目标：把研证插件安装到官方 agnes-harness（本机 D:\ZCode\agnes-harness）。
> 三种方式任选；全部完成后用同一标准验证：`@yanzheng/agh-plugin` 显示
> `desired=enabled actual=running trusted=true`，且 AGH 会话中可调用研证四工具。

## 前置（一次性，当前均已就绪）

| 项 | 状态 |
|---|---|
| AGH 已构建 | ✅ `D:\ZCode\agnes-harness\packages\cli\dist\local\agnes.mjs` 存在 |
| daemon 可运行 | ✅ 实测 running（Windows 原生模块已编译） |
| 插件发布副本 | ✅ 两个位置：`D:\ZCode\agh-plugins\yanzheng-thesis-review` 与 `D:\ZCode\agnes-harness\yanzheng-thesis-review` |

**关键规则**：`file:` 相对来源按 **daemon 启动目录** 解析——插件副本必须放在「启动 daemon 的那个目录」之下
（当前 daemon 从 agnes-harness 目录启动，故副本已放 `agnes-harness\yanzheng-thesis-review`）。

## 方式 A · AGH Web 界面（推荐，全程图形化）

0. **先起 daemon（关键前置，缺了 serve 会报 `local daemon has no Web capability`）**：
   ```bat
   set "AGH_HOME=D:\ZCode\agh-home"
   set "AGNES_PROFILE=local-dev"
   node packages\cli\dist\local\agnes.mjs daemon start
   ```
   daemon 的 Web 能力由 CLI 启动时自动附加的 `--local-web-addr/--local-web-origin`
   参数启用（origin 默认 `http://127.0.0.1:4177`），**不是环境变量**。
   实测踩坑：手动 `node packages\cli\dist\local\daemon.mjs` 直启的 daemon
   没有这两个参数 → discovery 里没有 `web` 字段 → 之后 `serve` 一律报
   no Web capability。修复：`agnes.mjs daemon stop` 后改用 `daemon start` 重启。
1. 启动 AGH Web（CMD，在 agnes-harness 目录，daemon 已在跑）：
   ```bat
   node packages\cli\dist\local\agnes.mjs serve --port 4177
   ```
   端口被占（EADDRINUSE 4177）说明 Web 已在运行，直接用浏览器即可。
2. 浏览器打开 http://127.0.0.1:4177 → 右上 **Settings** → **Plugin management**
3. 点 **Install from source** → Source type 选 **Local file** →
   Source reference 填 `file:./yanzheng-thesis-review` → **Check source**
4. 核对完整性摘要（名称/版本/贡献声明）→ 按向导继续**安装** → 打开启用开关
5. 官方说明：普通 Web 流程的信任校验已并入安装确认，无需单独 trust

实拍参考：`docs\agh-plugin-management.png`（插件列表中研证与官方助手并列、开关启用）。

## 方式 B · CLI 命令（CMD 窗口，daemon 运行中）

```bat
set "AGH_HOME=D:\ZCode\agh-home"
set "AGNES_PROFILE=local-dev"

node packages\cli\dist\local\agnes.mjs package inspect file:./yanzheng-thesis-review
REM   展示来源/版本/完整性摘要，提示 Install ... ? [y/N] 时输入 y 回车
node packages\cli\dist\local\agnes.mjs package trust @yanzheng/agh-plugin <integrity> <capabilityHash>
node packages\cli\dist\local\agnes.mjs package enable @yanzheng/agh-plugin
node packages\cli\dist\local\agnes.mjs package status
```

- trust 所需的两个哈希：从 `$AGH_HOME\data\daemon\package-operations\operations.json` 的
  preview 字段取（CLI 不打印）；或在 Web 界面安装（自动处理）
- 期望的最终状态：`@yanzheng/agh-plugin@0.6.0 desired=enabled actual=running trusted=true`

## 方式 C · 脚本自动（已封装）

`scripts\run-agh-e2e.cmd` 一条命令完成 inspect→install→trust→enable→3 步工具真实执行→
执行记录导出（SDK 直连 daemon，无需 TTY 确认）。首次环境搭建才需要方式 A/B。

## 真实评卷（可选）：给 daemon 配 LLM（插件 0.6.1+）

`thesis_review` 的 LLM 接入读 **daemon 进程环境变量**：有 `YANZHENG_API_KEY` 则真实评卷，
无则自动回退确定性 mock 演示模式（mock 时所有"严重级作假疑点→总仲裁复核→一票否决"链路
不会触发——mock 评卷员不产出严重疑点。要验证作假否决，必须真实评卷）。

```bat
REM 关键：key 在 daemon start 之前 set（serve 窗口 set 无效——key 是 daemon 进程读的）
set "AGH_HOME=D:\ZCode\agh-home"
set "AGNES_PROFILE=local-dev"
set "YANZHENG_API_KEY=sk-你的key"
set "YANZHENG_CONCURRENCY=3"       REM 限流端点（DeepSeek 13 并发会 500）降并发，1-3 稳
node packages\cli\dist\local\agnes.mjs daemon stop
node packages\cli\dist\local\agnes.mjs daemon start
node packages\cli\dist\local\agnes.mjs serve --port 4177
```

- 端点/模型经 `YANZHENG_LLM_BASE_URL` / `YANZHENG_MODEL_JUDGE` / `YANZHENG_MODEL_ARBITER`
  覆盖；缺省即 DeepSeek 官方（deepseek-flash 评卷 + deepseek-v4-pro 仲裁）
- 会话里让 AI 助手调用 thesis_review 时可加参数 `mock: true` 强制演示模式（不耗 key）
- AGH 助手（编排层）的模型在 Web 界面 Settings 里配；实测 AGH 内置 deepseek provider
  连通测试会被拒（CONFIG_TEST_FAILED），配 agnes-ai（赛事端点）可通
- **AGH 单次工具调用默认 120 秒上限会中止真实评卷**（助手见超时会自动改用 mock 重跑，
  产出演示报告——报告 mode 显示 mock 即此因）。解法：在
  `D:\ZCode\agnes-harness\packages\code\presets\standard-windows.yaml` 的
  `extends: standard` 下加（本机已加，daemon 重启生效）：
  ```yaml
  tools:
    timeout_ms: 600000
  ```
- 真实评卷耗时参考：DeepSeek 3 并发 × 13 员 ≈ 5–15 分钟/篇

## 安装后验证（三种方式通用）

1. `node packages\cli\dist\local\agnes.mjs package status` → 研证插件行含 `actual=running trusted=true`
2. AGH Web 界面 → Settings → Plugin management → 列表中有 `@yanzheng/agh-plugin 0.6.0` 且开关开启
3. AGH 会话输入"请用研证工具评审这篇论文"→ AI 助手自主调用 `thesis_gate → thesis_sections
   → thesis_review`，`thesis_review` 执行前弹出权限审批
4. 导出执行记录：`node packages\cli\dist\local\agnes.mjs export <sessionId> --format agnes -o 执行记录.jsonl`

## 卸载 / 更新（三级，全部实测）

### 1. 停用（保留安装与信任，随时可再启用）

```bat
node packages\cli\dist\local\agnes.mjs package disable @yanzheng/agh-plugin
```
实测结果：`desired=installed-disabled actual=not-running trusted=true`（工具立刻从会话撤下）。
重新启用：`node packages\cli\dist\local\agnes.mjs package enable @yanzheng/agh-plugin`。

### 2. 彻底卸载（连快照一起移除）

```bat
node packages\cli\dist\local\agnes.mjs package remove @yanzheng/agh-plugin
```
实测结果：`remove completed (100%)`，package status 不再列出。
重装：再走一遍 inspect/add/trust/enable（或直接跑 `scripts\run-agh-e2e.cmd` 一键装回）。

### 3. 停止 AGH 服务 / 彻底清理

```bat
REM 停 daemon（研证与 AGH Web 界面都会随之不可用）
set "AGH_HOME=D:\ZCode\agh-home"
set "AGNES_PROFILE=local-dev"
node packages\cli\dist\local\agnes.mjs daemon stop

REM Web 服务（4177）是独立进程：直接关其 CMD 窗口，或
taskkill /F /PID <serve进程PID>
```

彻底清理测试实例（删除会话/配置/已装插件，**不影响 agnes-harness 仓库本体**）：
删除 `D:\ZCode\agh-home` 目录即可；下次 `run-agh-e2e.cmd` 会全新重建。
若提示文件被占用：先 daemon stop 并结束残留 node 进程（tasklist 查 PID），稍候再删。

### 卸载后重装提示

- CMD 手动 `package add` 会弹交互确认（输 y）——非 TTY 管道下会静默取消（退出码仍 0，别被骗）；
  想免交互就用 Web 界面（方式 A）或 `run-agh-e2e.cmd`（SDK 无确认门）
- 卸载后再装时 `package trust` 需要新的 integrity/capabilityHash（来源内容变了哈希就变），
  从 operations.json 的 preview 或 Web 安装预览里取
