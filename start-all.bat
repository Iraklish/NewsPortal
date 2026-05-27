@echo off
echo Starting NewsPortal...
echo(

echo [1/3] Launching backend (Python 3.13 / FastAPI)...
start "NewsPortal Backend" cmd /k "cd /d "%~dp0backend" && py -3.13 -m pip install -r requirements.txt --quiet && echo. && echo Backend ready at http://localhost:8000 && echo. && py -3.13 -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000"

timeout /t 4 /nobreak > nul

echo [2/3] Launching scheduler (fetch + analyse loop)...
start "NewsPortal Scheduler" cmd /k "cd /d "%~dp0backend" && echo. && echo Scheduler starting — runs a fetch+analyse cycle on every configured interval && echo. && py -3.13 -m app.scheduler_launcher"

timeout /t 2 /nobreak > nul

echo [3/3] Launching frontend (Next.js)...
start "NewsPortal Frontend" cmd /k "cd /d "%~dp0frontend" && npm install --no-audit --no-fund && echo. && echo Frontend ready at http://localhost:3000 && echo. && npm run dev"

echo(
echo All three services are starting in separate windows.
echo   Backend:   http://localhost:8000
echo   Scheduler: runs automatically on the configured interval
echo   Frontend:  http://localhost:3000
echo(
echo Close those windows (or press Ctrl+C in each) to stop.
