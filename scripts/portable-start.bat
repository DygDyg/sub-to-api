@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title SubToAPI
rem Usage: start.bat [--console] [--no-tray]
rem   --console  show a console window with the server log
rem   --no-tray  do not create the tray icon
if not exist "%~dp0sub-to-api.exe" (
  echo sub-to-api.exe not found
  pause
  exit /b 1
)
set "PORT=8787"
set "STATE=%~dp0settings\state.json"
if not exist "%STATE%" set "STATE=%USERPROFILE%\.sub-to-api\state.json"
if exist "%STATE%" (
  for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$s = Get-Content -Raw -LiteralPath $env:STATE | ConvertFrom-Json; if ($s.settings.port) { $s.settings.port }"`) do set "PORT=%%P"
)
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%PORT%/ -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 (
  start "" "http://127.0.0.1:%PORT%"
  exit /b 0
)
start "SubToAPI" "%~dp0sub-to-api.exe" %*
echo Waiting for SubToAPI to start...
for /l %%I in (1,1,20) do (
  timeout /t 1 /nobreak >nul
  powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%PORT%/ -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
  if not errorlevel 1 (
    start "" "http://127.0.0.1:%PORT%"
    exit /b 0
  )
)
echo Server did not respond. Run start.bat --console to see the log.
pause
exit /b 1
