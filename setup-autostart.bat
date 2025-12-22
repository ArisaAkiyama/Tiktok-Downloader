@echo off
echo ========================================
echo   TikDown - Setup Windows Autostart
echo ========================================
echo.

set "SCRIPT_PATH=%~dp0start-silent.vbs"
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_FOLDER%\TikDown.vbs"

echo Creating autostart shortcut...
copy "%SCRIPT_PATH%" "%SHORTCUT_PATH%" >nul

if exist "%SHORTCUT_PATH%" (
    echo.
    echo ✅ Autostart enabled!
    echo    TikDown will start automatically when Windows boots.
    echo.
    echo    Shortcut location:
    echo    %SHORTCUT_PATH%
) else (
    echo.
    echo ❌ Failed to create autostart shortcut.
    echo    Please run as Administrator.
)

echo.
pause
