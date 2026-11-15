@echo off
REM Wallpaper Meta-Search — double-click start (Windows).
REM Starts the local CORS proxy (port 8787) and serves the app on port 8090.
REM The app auto-detects the local proxy when served from localhost, so
REM Wallhaven works with no Settings changes. Close this window to stop
REM anything it started; already-running copies are reused, not restarted.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required (https://nodejs.org). It is not installed or not on PATH.
  pause
  exit /b 1
)

REM Reuse an already-running proxy if :8787 answers at all.
curl -s -m 2 -o nul http://localhost:8787/ >nul 2>nul
if not errorlevel 1 (
  echo Proxy already running on :8787 — reusing it.
) else (
  start "Wallpaper Meta-Search proxy" /min node proxy\server.mjs
)

REM Reuse :8090 only if it is already serving this app.
curl -s -m 2 http://localhost:8090/index.html 2>nul | findstr /c:"Wallpaper Meta-Search" >nul
if not errorlevel 1 (
  echo App already running on :8090 — reusing it.
) else (
  where python >nul 2>nul
  if not errorlevel 1 (
    start "Wallpaper Meta-Search app" /min python -m http.server 8090
  ) else (
    echo Python was not found, so the app server was not started.
    echo Open index.html directly, or install Python to serve it on port 8090.
    pause
    exit /b 1
  )
)

timeout /t 1 /nobreak >nul
echo.
echo   Wallpaper Meta-Search is running:
echo     App:   http://localhost:8090/
echo     Proxy: http://localhost:8787/ (Wallhaven goes through this)
echo   Close this window to stop what it started.
echo.
start http://localhost:8090/
