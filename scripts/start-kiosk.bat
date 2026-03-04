@echo off
:: ─────────────────────────────────────────────────────────────────
:: PrintBit Kiosk Startup Script
:: Starts the PrintBit server (which auto-launches MyPublicWiFi)
:: and opens Edge in kiosk mode.
::
:: This script self-elevates to Administrator if needed.
:: ─────────────────────────────────────────────────────────────────

:: Check for admin
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [PrintBit] Requesting administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

:: Set project directory (parent of scripts\)
cd /d "%~dp0.."
set "PROJECT_DIR=%cd%"
echo [PrintBit] Project: %PROJECT_DIR%

:: Ensure pnpm is available
where pnpm >nul 2>&1
if %errorlevel% neq 0 (
    echo [PrintBit] ERROR: pnpm not found. Install it with: npm install -g pnpm
    pause
    exit /b 1
)

:: Start PrintBit server (this also launches MyPublicWiFi + hotspot)
echo [PrintBit] Starting server...
start "PrintBit Server" /min cmd /c "cd /d "%PROJECT_DIR%" && pnpm run dev"

:: Wait for server to come up
echo [PrintBit] Waiting for server to start...
timeout /t 8 /nobreak >nul

:: Launch Edge in kiosk mode
echo [PrintBit] Launching kiosk browser...
start "" msedge.exe --kiosk http://localhost:3000 --edge-kiosk-type=fullscreen

echo [PrintBit] Kiosk started successfully.
