@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title SubToAPI package
where node >nul 2>&1
if errorlevel 1 (
  echo Для сборки нужен Node.js 22 или новее.
  pause
  exit /b 1
)
node scripts\build-portable.mjs
if errorlevel 1 (
  echo Сборка не удалась.
  pause
  exit /b 1
)
echo.
echo Готово: %~dp0release\SubToAPI
echo Запуск собранной программы: release\SubToAPI\start.bat
start "" "%~dp0release\SubToAPI"
exit /b 0
