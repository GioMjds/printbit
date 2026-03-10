@echo off
:: ─────────────────────────────────────────────────────────────────
:: PrintBit Kiosk Startup Script
:: Starts the PrintBit server (which auto-launches MyPublicWiFi)
:: and opens Edge in kiosk mode using dynamic local IP.
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

:: Resolve dynamic local IPv4 (first non-loopback adapter)
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /R "IPv4.*[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*"') do (
    set "LOCAL_IP=%%A"
    goto :got_ip
)
:got_ip
:: Strip leading space left by the "delims=:" split

for /f "tokens=1 delims= (" %%A in ("%LOCAL_IP%") do set "LOCAL_IP=%%A"

:: Exclude link-local addresses (fallback to localhost)
if "%LOCAL_IP:~0,8%"=="169.254." set "LOCAL_IP="

if "%LOCAL_IP%"=="" (
    echo [PrintBit] WARNING: Could not detect local IP. Falling back to localhost.
    set "LOCAL_IP=localhost"
)

set "PORT=3000"
set "KIOSK_URL=http://%LOCAL_IP%:%PORT%"
echo [PrintBit] Kiosk URL: %KIOSK_URL%

:: Start PrintBit server (this also launches MyPublicWiFi + hotspot)
echo [PrintBit] Starting server...
start "PrintBit Server" /min cmd /c "cd /d "%PROJECT_DIR%" && pnpm run dev"

:: Wait for server to come up
echo [PrintBit] Waiting for server to start...
timeout /t 8 /nobreak >nul

:: Launch Edge in kiosk mode pointed at the dynamic IP
echo [PrintBit] Launching kiosk browser...
start "" msedge.exe --kiosk %KIOSK_URL% --edge-kiosk-type=fullscreen

echo [PrintBit] Kiosk started successfully at %KIOSK_URL%.