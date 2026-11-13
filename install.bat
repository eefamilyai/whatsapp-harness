@echo off
setlocal
title WhatsApp assistant - install / update
rem ====================================================================================
rem  Installs (or updates) the WhatsApp assistant on a Windows machine.
rem
rem    install.bat [DEEPSEEK_API_KEY] [/dir:C:\path] [/nolink] [/notask]
rem
rem  - installs Node.js (portable, no admin) if the machine has none or an old one
rem  - downloads the latest GitHub release, keeps your .env and data\ on updates
rem  - asks for the DeepSeek API key (only if .env has none), then links WhatsApp
rem  - registers a scheduled task so it starts at logon and restarts if it crashes
rem  Safe to run again: that is how you update.
rem ====================================================================================

set "REPO=eefamilyai/whatsapp-harness"
set "DIR=%USERPROFILE%\whatsapp-harness"
set "NOLINK="
set "NOTASK="
set "KEY=%WAH_KEY%"

:args
if "%~1"=="" goto argsdone
set "A=%~1"
if /i "%A:~0,5%"=="/dir:" (
  set "DIR=%A:~5%"
) else if /i "%A%"=="/nolink" (
  set "NOLINK=1"
) else if /i "%A%"=="/notask" (
  set "NOTASK=1"
) else (
  set "KEY=%A%"
)
shift
goto args
:argsdone

set "PS=powershell -NoProfile -ExecutionPolicy Bypass -Command"
set "TLS=[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $ProgressPreference='SilentlyContinue';"
set "TASK=WhatsAppHarness"

echo.
echo === WhatsApp assistant installer ===
echo Install folder: %DIR%
echo.

rem ---------- 1. Node.js >= 20 ----------
set "NODEMAJOR=0"
if not defined WAH_FORCE_NODE (
  for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODEMAJOR=%%v"
)
if %NODEMAJOR% GEQ 20 (
  echo [1/6] Node.js %NODEMAJOR% found.
  goto nodeok
)
echo [1/6] Installing a private copy of Node.js ^(no admin needed^)...
set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
set "NODE_ZIPDIR=%TEMP%\wah-node"
if exist "%NODE_ZIPDIR%" rmdir /s /q "%NODE_ZIPDIR%"
mkdir "%NODE_ZIPDIR%"
set "WAH_ARCH=%ARCH%"
set "WAH_NODE_OUT=%NODE_ZIPDIR%"
%PS% "%TLS% $v=(Invoke-RestMethod 'https://nodejs.org/dist/index.json' | Where-Object { $_.lts } | Select-Object -First 1).version; Write-Host ('      Node ' + $v); Invoke-WebRequest -UseBasicParsing -Uri ('https://nodejs.org/dist/' + $v + '/node-' + $v + '-win-' + $env:WAH_ARCH + '.zip') -OutFile (Join-Path $env:WAH_NODE_OUT 'node.zip'); Expand-Archive -Force -LiteralPath (Join-Path $env:WAH_NODE_OUT 'node.zip') -DestinationPath $env:WAH_NODE_OUT; $d=Get-ChildItem $env:WAH_NODE_OUT -Directory | Select-Object -First 1; if (Test-Path (Join-Path $env:DIR 'node')) { Remove-Item -Recurse -Force (Join-Path $env:DIR 'node') }; New-Item -ItemType Directory -Force $env:DIR | Out-Null; Move-Item $d.FullName (Join-Path $env:DIR 'node')"
if errorlevel 1 goto fail_node
if not exist "%DIR%\node\node.exe" goto fail_node
rmdir /s /q "%NODE_ZIPDIR%" 2>nul
:nodeok
set "NODE_EXE=node"
if exist "%DIR%\node\node.exe" (
  set "PATH=%DIR%\node;%PATH%"
  set "NODE_EXE=%DIR%\node\node.exe"
)

rem ---------- 2. stop a running copy, download the release ----------
echo [2/6] Downloading the latest release...
set "WAH_DIR=%DIR%"
%PS% "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:WAH_DIR) -and ($_.CommandLine -like '*run.bat*' -or $_.CommandLine -like '*dist\index.js*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1
schtasks /end /tn "%TASK%" >nul 2>&1

set "STAGE=%TEMP%\wah-release"
if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%"
set "WAH_STAGE=%STAGE%"
set "WAH_URL=https://github.com/%REPO%/releases/latest/download/whatsapp-harness.zip"
%PS% "%TLS% Invoke-WebRequest -UseBasicParsing -Uri $env:WAH_URL -OutFile (Join-Path $env:WAH_STAGE 'release.zip'); Expand-Archive -Force -LiteralPath (Join-Path $env:WAH_STAGE 'release.zip') -DestinationPath (Join-Path $env:WAH_STAGE 'x')"
if errorlevel 1 goto fail_download
if not exist "%STAGE%\x\dist\index.js" goto fail_download

rem ---------- 3. put the files in place (data\ and .env are never touched) ----------
echo [3/6] Installing files...
if not exist "%DIR%" mkdir "%DIR%"
if exist "%DIR%\dist" rmdir /s /q "%DIR%\dist"
if exist "%DIR%\node_modules" rmdir /s /q "%DIR%\node_modules"
xcopy /e /y /q "%STAGE%\x\*" "%DIR%\" >nul
if errorlevel 1 goto fail_copy
rmdir /s /q "%STAGE%" 2>nul

rem ---------- 4. dependencies ----------
echo [4/6] Installing dependencies ^(1-2 minutes^)...
pushd "%DIR%"
call npm ci --omit=dev --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  popd
  goto fail_npm
)
if not exist data mkdir data

rem ---------- 5. configuration ----------
echo [5/6] Configuring...
if not exist .env copy /y .env.example .env >nul
set "WAH_ENV=%DIR%\.env"
set "HAVEKEY="
for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b /c:"LLM_API_KEY=" "%DIR%\.env"`) do if not "%%b"=="" set "HAVEKEY=1"
if not defined KEY if not defined HAVEKEY (
  echo.
  echo   Paste your DeepSeek API key ^(platform.deepseek.com/api_keys^) and press Enter.
  set /p "KEY=  API key: "
)
if defined KEY (
  set "WAH_KEY=%KEY%"
  call :setenv LLM_API_KEY WAH_KEY
  set "HAVEKEY=1"
)
if not defined HAVEKEY (
  echo.
  echo   No API key given. Put it in %DIR%\.env ^(LLM_API_KEY=...^) and run install.bat again.
  popd
  exit /b 1
)

if defined NOLINK goto skiplink
if exist "data\auth\creds.json" (
  echo   WhatsApp is already linked.
  goto skiplink
)
echo.
echo   Optional: your WhatsApp number with country code, digits only ^(e.g. 6591234567^).
echo   Enter it to link with an 8-character pairing code instead of a QR code.
set "PAIR="
set /p "PAIR=  Number ^(or just Enter for a QR code^): "
if defined PAIR (
  set "WAH_PAIR=%PAIR%"
  call :setenv PAIRING_NUMBER WAH_PAIR
)
echo.
echo   Linking WhatsApp. On your phone: Settings ^> Linked devices ^> Link a device.
echo.
"%NODE_EXE%" dist\index.js --link
if errorlevel 1 (
  popd
  goto fail_link
)
:skiplink

rem ---------- 6. start automatically ----------
if defined NOTASK (
  popd
  echo [6/6] Skipped the scheduled task. Start it with: %DIR%\run.bat
  goto done
)
echo [6/6] Registering the startup task...
set "WAH_RUN=%DIR%\run.bat"
schtasks /create /tn "%TASK%" /sc onlogon /rl limited /f /tr "powershell.exe -NoProfile -WindowStyle Hidden -Command \"Start-Process -WindowStyle Hidden -FilePath '%DIR%\run.bat'\"" >nul
if errorlevel 1 (
  echo   Could not create the scheduled task. Start it by hand with: %DIR%\run.bat
) else (
  schtasks /run /tn "%TASK%" >nul
  echo   Started. It will start again at every logon and restart itself if it crashes.
)
popd

:done
echo.
echo ================================================================
echo  Done. Open WhatsApp ^> "Message yourself" and send: /help
echo.
echo  Logs:    type "%DIR%\data\bot.log"
echo  Update:  "%DIR%\install.bat"
echo  Stop:    schtasks /end /tn %TASK%
echo  Remove:  schtasks /delete /tn %TASK% /f   ^(then delete %DIR%^)
echo ================================================================
exit /b 0

rem ---- helper: :setenv NAME VARNAME  -> sets NAME=<value of %VARNAME%> in .env (adds the line if missing) ----
:setenv
set "WAH_NAME=%~1"
set "WAH_VAR=%~2"
%PS% "$n=$env:WAH_NAME; $v=[Environment]::GetEnvironmentVariable($env:WAH_VAR); $f=$env:WAH_ENV; $found=$false; $out=foreach($l in Get-Content $f){ if($l -like ($n+'=*')){ $found=$true; $n+'='+$v } else { $l } }; if(-not $found){ $out=@($out)+($n+'='+$v) }; [IO.File]::WriteAllLines($f,[string[]]$out)"
exit /b 0

:fail_node
echo.
echo ERROR: could not install Node.js automatically. Install Node 20 or newer from https://nodejs.org and run this again.
exit /b 1
:fail_download
echo.
echo ERROR: could not download %WAH_URL%
echo Check the internet connection, and that the repo and its latest release exist.
exit /b 1
:fail_copy
echo.
echo ERROR: could not copy files into %DIR%
exit /b 1
:fail_npm
echo.
echo ERROR: npm could not install the dependencies. Scroll up for the reason.
exit /b 1
:fail_link
echo.
echo ERROR: WhatsApp was not linked. Run this again to retry ^(the previous attempt left nothing half-done^).
exit /b 1
