@echo off
echo ========================================
echo   TikDown - Remove Windows Autostart
echo ========================================
echo.

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_FOLDER%\TikDown.vbs"

if exist "%SHORTCUT_PATH%" (
    del "%SHORTCUT_PATH%"
    echo ✅ Autostart removed!
    echo    TikDown will no longer start with Windows.
) else (
    echo ⚠️ Autostart was not enabled.
)

echo.
pause
