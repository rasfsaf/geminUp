@echo off
setlocal
title geminUp

if not exist "%~dp0geminUp.ps1" (
    if exist "%~dp0geminUp-bootstrap.bat" (
        call "%~dp0geminUp-bootstrap.bat"
        exit /b %errorlevel%
    )
    echo [ERROR] geminUp.ps1 is missing.
    echo Download the complete release ZIP or geminUp-bootstrap.bat.
    pause
    exit /b 1
)

net session >nul 2>&1
if errorlevel 1 (
    echo [INFO] Requesting administrator privileges...
    set "GEMINUP_LAUNCHER=%~f0"
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath $env:GEMINUP_LAUNCHER -Verb RunAs"
    exit /b
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0geminUp.ps1" menu
set "transport_exit=%errorlevel%"
if not "%transport_exit%"=="0" (
    echo.
    echo [ERROR] geminUp exited with code %transport_exit%.
)
echo.
echo Press any key to close geminUp...
pause >nul
exit /b %transport_exit%
