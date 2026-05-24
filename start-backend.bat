@echo off
cd /d "%~dp0backend"

REM Use Python 3.13 where the packages are installed.
REM "py -3.13" uses the Windows Python Launcher; falls back to the full path.
set PYTHON=py -3.13
%PYTHON% --version >nul 2>&1 || set PYTHON="C:\Program Files\Python313\python.exe"

echo Installing / verifying dependencies...
%PYTHON% -m pip install -r requirements.txt --quiet
echo.

for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    for /f "tokens=* delims= " %%b in ("%%a") do set LAN_IP=%%b
)
echo Starting NewsPortal backend.
echo   Local:   http://localhost:8000
echo   Network: http://%LAN_IP%:8000
echo Press Ctrl+C to stop.
%PYTHON% -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
