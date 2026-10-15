@echo off
REM Runs BetSend in this window — handy for a quick look or for troubleshooting.
REM For everyday use install it properly with "Install BetSend.bat" so it starts
REM with Windows and nobody has to leave a window open.

title BetSend
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo   Get the LTS installer from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

if not exist "server\dist\index.js" (
  echo.
  echo   First run — building BetSend. This takes a minute.
  echo.
  call npm install || goto :failed
  call npm run build || goto :failed
)

echo.
node server\dist\index.js
echo.
echo   BetSend has stopped.
pause
exit /b 0

:failed
echo.
echo   The build failed. The output above says why.
pause
exit /b 1
