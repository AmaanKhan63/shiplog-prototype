@echo off
REM ---------------------------------------------------------------------------
REM  dev.bat - start the whole local stack in ONE split terminal window.
REM
REM    server    (npm run dev)          API on http://localhost:3000
REM    worker    (npm run worker)       ingest + nango-sync + reconcile workers
REM    ngrok     (ngrok http 3000)      public HTTPS for the Nango webhook
REM    dashboard (npm run dev)          Vite UI on http://localhost:5173
REM
REM  Prereqs: Windows Terminal (wt.exe, ships with Win11), ngrok on PATH, and
REM  `npm install` already run in BOTH the repo root and dashboard/.
REM
REM  Layout (2x2):   server | dashboard
REM                  worker | ngrok
REM
REM  Falls back to four separate windows if Windows Terminal isn't installed.
REM ---------------------------------------------------------------------------

where wt >nul 2>nul && goto wt

echo Windows Terminal (wt.exe) not found - opening four separate windows instead.
start "shiplog server"    /d "%~dp0."          cmd /k npm run dev
start "shiplog worker"    /d "%~dp0."          cmd /k npm run worker
start "ngrok"             /d "%~dp0."          cmd /k ngrok http 3000
start "shiplog dashboard" /d "%~dp0dashboard"  cmd /k npm run dev
goto :eof

:wt
wt new-tab     --title server    -d "%~dp0."          cmd /k npm run dev ^
  ; split-pane -V --title dashboard -d "%~dp0dashboard"  cmd /k npm run dev ^
  ; split-pane -H --title ngrok     -d "%~dp0."          cmd /k ngrok http 3000 ^
  ; move-focus left ^
  ; split-pane -H --title worker    -d "%~dp0."          cmd /k npm run worker
