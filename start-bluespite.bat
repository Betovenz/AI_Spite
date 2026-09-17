@echo off
REM Starts the BlueSPite bridge + web UI, then opens the browser.
REM The extension finds the bridge on its own (port scan), so nothing to configure.
cd /d "%~dp0"
start "" http://127.0.0.1:24242/
node server\server.mjs
REM A clean shutdown (closing this window's Ctrl+C, server.mjs's SIGINT handler)
REM exits 0 and the window just closes as before. Anything else — a crash — exits
REM non-zero, and without this the window would close in that same instant too,
REM taking the stack trace with it before anyone could read it ("the server keeps
REM closing itself" with nothing to go on). Pausing only in that case shows the
REM error and keeps it on screen instead.
if not "%errorlevel%"=="0" (
  echo.
  echo [BlueSPite] bridge process exited with code %errorlevel% — see the error above.
  pause
)
