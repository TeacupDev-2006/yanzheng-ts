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

1. 启动 AGH Web（CMD，在 agnes-harness 目录）：
   ```bat
   set "AGH_HOME=D:\ZCode\agh-home"
   set "AGNES_PROFILE=local-dev"
   node packages\cli\dist\local\agnes.mjs serve --port 4177
   ```
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
set "AGH=packages\cli\dist\local\agnes.mjs"

node %AGH% package inspect file:./yanzheng-thesis-review
REM   ↑ 展示来源/版本/完整性摘要，提示 Install ... ? [y/N] 时输入 y 回车
node %AGH% package trust @yanzheng/agh-plugin <integrity> <capabilityHash>
node %AGH% package enable @yanzheng/agh-plugin
node %AGH% package status
```

- trust 所需的两个哈希：从 `$AGH_HOME\data\daemon\package-operations\operations.json` 的
  preview 字段取（CLI 不打印）；或在 Web 界面安装（自动处理）
- 期望的最终状态：`@yanzheng/agh-plugin@0.6.0 desired=enabled actual=running trusted=true`

## 方式 C · 脚本自动（已封装）

`scripts\run-agh-e2e.cmd` 一条命令完成 inspect→install→trust→enable→3 步工具真实执行→
执行记录导出（SDK 直连 daemon，无需 TTY 确认）。首次环境搭建才需要方式 A/B。

## 安装后验证（三种方式通用）

1. `node %AGH% package status` → 研证插件行含 `actual=running trusted=true`
2. AGH Web 界面 → Settings → Plugin management → 列表中有 `@yanzheng/agh-plugin 0.6.0` 且开关开启
3. AGH 会话输入"请用研证工具评审这篇论文"→ AI 助手自主调用 `thesis_gate → thesis_sections
   → thesis_review`，`thesis_review` 执行前弹出权限审批
4. 导出执行记录：`node %AGH% export <sessionId> --format agnes -o 执行记录.jsonl`

## 卸载 / 更新（三级，全部实测）

### 1. 停用（保留安装与信任，随时可再启用）

```bat
node %AGH% package disable @yanzheng/agh-plugin
```
实测结果：`desired=installed-disabled actual=not-running trusted=true`（工具立刻从会话撤下）。
重新启用：`node %AGH% package enable @yanzheng/agh-plugin`。

### 2. 彻底卸载（连快照一起移除）

```bat
node %AGH% package remove @yanzheng/agh-plugin
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
