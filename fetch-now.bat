@echo off
REM Manually trigger the NewsPortal fetch+analyze cycle.
REM Usage:  fetch-now.bat
REM         fetch-now.bat -ApiBase http://192.168.1.5:8000
REM         fetch-now.bat -TimeoutMinutes 30
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fetch-now.ps1" %*
exit /b %ERRORLEVEL%
