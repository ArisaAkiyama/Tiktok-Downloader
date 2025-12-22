@echo off
echo Stopping TikDown server...
taskkill /F /IM node.exe /FI "WINDOWTITLE eq TikDown*" 2>nul
taskkill /F /IM node.exe /FI "MEMUSAGE gt 50000" 2>nul
echo.
echo Server stopped!
timeout /t 2 >nul
