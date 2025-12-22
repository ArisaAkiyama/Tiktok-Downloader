@echo off
cd /d "%~dp0"
start /min cmd /c "node server.js"
echo TikDown server started in background!
timeout /t 2 >nul
