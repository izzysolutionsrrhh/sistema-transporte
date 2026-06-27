@echo off
title Sistema de Recorridos
echo.
echo ========================================
echo   Iniciando Sistema de Recorridos...
echo ========================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo ERROR: Node.js no esta instalado.
  echo Descargalo desde https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo Instalando dependencias por primera vez...
  npm install
  echo.
)

node server.js
pause
