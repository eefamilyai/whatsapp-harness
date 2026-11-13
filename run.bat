@echo off
rem Keeps the assistant running: restarts it if it crashes. Started by the scheduled task.
cd /d "%~dp0"
set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
if not exist data mkdir data
:loop
for %%F in (data\bot.log) do if %%~zF GTR 5000000 move /y data\bot.log data\bot.old.log >nul
"%NODE%" "%~dp0dist\index.js" >> data\bot.log 2>&1
set "CODE=%errorlevel%"
echo [%date% %time%] exited with code %CODE% >> data\bot.log
rem Code 2 = WhatsApp logged this device out: restarting would not help.
if "%CODE%"=="2" exit /b 2
timeout /t 10 /nobreak >nul
goto loop
