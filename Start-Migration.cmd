@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0" || exit /b 1
where node.exe >nul 2>&1 || (
  echo Node.js 20 or newer is required. https://nodejs.org/
  pause
  exit /b 1
)
if not exist "node_modules\playwright\package.json" (
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node migrate.mjs %*
set "migration_exit=%errorlevel%"
popd
if "%~1"=="" pause
exit /b %migration_exit%
