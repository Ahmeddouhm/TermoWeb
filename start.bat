@echo off
setlocal
cd /d "%~dp0"
title Web Terminal Server

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Opening the download page...
  start "" https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies ^(first run only^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

node server.js --open
echo.
echo Server stopped.
pause
