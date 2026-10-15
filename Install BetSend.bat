@echo off
title BetSend setup
echo.
echo   Setting up BetSend. Windows will ask for administrator rights.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
if errorlevel 1 (
  echo.
  echo   Setup did not finish. The message above says why.
  pause
)
