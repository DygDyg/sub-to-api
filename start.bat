@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title SubToAPI

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js не найден в PATH.
  echo Установите Node.js 22 или новее: https://nodejs.org/
  pause
  exit /b 1
)

set "PORT=8787"
set "STATE=%~dp0settings\state.json"
if not exist "%STATE%" set "STATE=%USERPROFILE%\.sub-to-api\state.json"
if exist "%STATE%" (
  for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$s = Get-Content -Raw -LiteralPath $env:STATE | ConvertFrom-Json; if ($s.settings.port) { $s.settings.port }"`) do set "PORT=%%P"
)

echo Останавливаю предыдущую копию...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1" -Port %PORT%
if errorlevel 1 (
  echo Не удалось остановить предыдущую копию.
  pause
  exit /b 1
)

start "SubToAPI" /D "%~dp0" node src\cli.js

echo Ожидание запуска...
for /l %%I in (1,1,20) do (
  timeout /t 1 /nobreak >nul
  powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%PORT%/ -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
  if not errorlevel 1 (
    echo Открываю http://127.0.0.1:%PORT%
    start "" "http://127.0.0.1:%PORT%"
    exit /b 0
  )
)

echo Сервер не ответил. Смотрите окно SubToAPI.
echo Если порт занят, откройте настройки и укажите другой.
pause
exit /b 1
