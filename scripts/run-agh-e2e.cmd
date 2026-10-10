@echo off
REM Yanzheng AGH e2e one-shot rerun (CMD). Prereq one-time (done): VS BuildTools,
REM D:\ZCode\node-headers\24.21.0, agnes-harness build:local.
setlocal
cd /d "D:\ZCode\2026年江苏省AI+科学与工程创新实践黑客松 TS重构"

set "AGH_HOME=D:\ZCode\agh-home"
set "AGNES_PROFILE=local-dev"
set "AGNES_NODE_HEADERS=D:\ZCode\node-headers\24.21.0"

echo [1/2] running AGH e2e via tsx ...
node "D:\ZCode\agnes-harness\node_modules\tsx\dist\cli.mjs" "%~dp0agh-e2e.mjs"
if errorlevel 1 (
  echo.
  echo [FAILED] if daemon-related, run:
  echo   set "AGH_HOME=D:\ZCode\agh-home"
  echo   set "AGNES_PROFILE=local-dev"
  echo   node "D:\ZCode\agnes-harness\packages\cli\dist\local\agnes.mjs" daemon stop
  echo then rerun this script.
  exit /b 1
)
echo.
echo [2/2] DONE. Evidence: docs\AGH执行记录.jsonl / .html
