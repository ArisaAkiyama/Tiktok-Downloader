@echo off
title TikDown Server
echo ========================================
echo    TikDown - TikTok Downloader Server
echo ========================================
echo.
echo Starting server...
echo.

cd /d "%~dp0"
node server.js

pause
