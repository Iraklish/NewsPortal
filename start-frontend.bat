@echo off
cd /d "%~dp0frontend"
echo Installing dependencies...
npm install --no-audit --no-fund
echo(
echo Starting NewsPortal frontend...
echo   http://localhost:3000
echo(
npm run dev
