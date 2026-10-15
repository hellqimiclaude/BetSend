@echo off
setlocal EnableExtensions
title BetSend Setup

REM ===========================================================================
REM  BetSend one-file setup for Windows.
REM
REM  Hand this single file to whoever sets up the office PC. Double-clicking it
REM  fetches the current code, puts it in C:\BetSend and runs the installer,
REM  which registers BetSend to start with Windows.
REM
REM  Usage:  double-click it.
REM
REM  Needs:  Windows 10 or newer, and an internet connection during setup.
REM          Node.js is installed for you if winget is available.
REM
REM  The app folder is small; the directory that holds people's files is set
REM  separately and can live on another drive:
REM      powershell -ExecutionPolicy Bypass -File C:\BetSend\scripts\install.ps1 -StorageDir D:\BetSendData
REM ===========================================================================

set "REPO=hellqimiclaude/BetSend"
set "BRANCH=claude/lan-file-transfer-app-b5b9xn"
set "TARGET=C:\BetSend"

REM The archive unpacks to BetSend-<branch with slashes turned into dashes>.
set "FOLDER=BetSend-%BRANCH:/=-%"
set "URL=https://github.com/%REPO%/archive/refs/heads/%BRANCH%.zip"

echo.
echo   BetSend Setup
echo   Installing to: %TARGET%
echo.

REM --- administrator ---------------------------------------------------------
REM Needed to open the firewall and register the startup task. Ask Windows
REM rather than telling the user to right-click the right thing.
net session >nul 2>&1
if not errorlevel 1 goto :elevated
echo   Asking Windows for administrator rights...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b 0

:elevated

REM --- Node.js ---------------------------------------------------------------
where node >nul 2>&1
if not errorlevel 1 goto :have_node

echo   Node.js is not installed.
where winget >nul 2>&1
if errorlevel 1 goto :no_winget

echo   Installing it with winget. This takes a couple of minutes.
echo.
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
echo.
echo   ----------------------------------------------------------------
echo    Node.js is installed, but this window still has the old PATH.
echo    Close it and run BetSend-Setup again to finish.
echo   ----------------------------------------------------------------
echo.
pause
exit /b 0

:no_winget
echo.
echo   Install Node.js LTS from https://nodejs.org and run this again.
echo   (Take the default options in the installer.)
echo.
pause
exit /b 1

:have_node
for /f "tokens=*" %%v in ('node --version') do set "NODEVER=%%v"
echo   Node.js %NODEVER% found.

REM --- download --------------------------------------------------------------
set "ZIP=%TEMP%\betsend-setup.zip"
set "WORK=%TEMP%\betsend-setup-unpack"

echo   Downloading BetSend...
if exist "%ZIP%" del /q "%ZIP%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -OutFile '%ZIP%'"
if errorlevel 1 goto :download_failed
if not exist "%ZIP%" goto :download_failed

REM --- unpack ----------------------------------------------------------------
echo   Unpacking...
if exist "%WORK%" rmdir /s /q "%WORK%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '%ZIP%' -DestinationPath '%WORK%' -Force"
if errorlevel 1 goto :unpack_failed
if not exist "%WORK%\%FOLDER%\package.json" goto :unpack_failed

REM --- copy into place -------------------------------------------------------
REM /XF and /XD protect anything an existing install owns: the configuration
REM with its admin token, the files people have already sent, and the logs.
echo   Copying to %TARGET%...
robocopy "%WORK%\%FOLDER%" "%TARGET%" /E /NFL /NDL /NJH /NJS /NP /XF config.json /XD data logs node_modules >nul
if errorlevel 8 goto :copy_failed

del /q "%ZIP%" >nul 2>&1
rmdir /s /q "%WORK%" >nul 2>&1

REM --- hand over to the real installer ---------------------------------------
echo   Starting the installer...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%TARGET%\scripts\install.ps1"
if errorlevel 1 goto :install_failed

echo.
echo   Setup finished. You can delete this file.
echo.
pause
exit /b 0

REM --- failures --------------------------------------------------------------
:download_failed
echo.
echo   Could not download BetSend.
echo   Check this machine can reach github.com, then run this again.
echo   URL: %URL%
echo.
pause
exit /b 1

:unpack_failed
echo.
echo   The download arrived but could not be unpacked. Try running this again.
echo.
pause
exit /b 1

:copy_failed
echo.
echo   Could not copy the files into %TARGET%.
echo   Check the drive exists and has room, then run this again.
echo.
pause
exit /b 1

:install_failed
echo.
echo   The installer did not finish. The messages above say why.
echo.
pause
exit /b 1
