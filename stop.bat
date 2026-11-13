@echo off
rem Stops the assistant (and its auto-restart loop) in this folder.
set "WAH_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:WAH_DIR) -and ($_.CommandLine -like '*run.bat*' -or $_.CommandLine -like '*dist\index.js*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
schtasks /end /tn WhatsAppHarness >nul 2>&1
echo Stopped.
