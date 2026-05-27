@echo off
echo Starting NewsPortal...
echo(

echo [1/2] Launching backend (Python 3.13 / FastAPI + scheduler)...
start "NewsPortal Backend" cmd /k "cd /d "%~dp0backend" && py -3.13 -m pip install -r requirements.txt --quiet && echo. && echo Backend + scheduler ready at http://localhost:8000 && echo. && py -3.13 -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000"

timeout /t 4 /nobreak > nul

echo [2/2] Launching frontend (Next.js)...
start "NewsPortal Frontend" cmd /k "cd /d "%~dp0frontend" && npm install --no-audit --no-fund && echo. && echo Frontend ready at http://localhost:3000 && echo. && npm run dev"

echo(
echo Both services are starting in separate windows.
echo   Backend + Scheduler: http://localhost:8000
echo   Frontend:            http://localhost:3000
echo(
echo The scheduler runs automatically inside the backend process.
echo Close those windows (or press Ctrl+C in each) to stop.
