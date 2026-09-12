@echo off
:: ─────────────────────────────────────────────────────────────────
:: PrintBit Kiosk Startup Script
:: Starts the compiled PrintBit server and opens Edge in kiosk mode
:: using dynamic local IP with /loading startup route.
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

if "%PRINTBIT_KIOSK_LOCKDOWN%"=="" set "PRINTBIT_KIOSK_LOCKDOWN=true"
if "%PRINTBIT_USB_EXPORT_ENABLED%"=="" set "PRINTBIT_USB_EXPORT_ENABLED=false"
echo [PrintBit] Kiosk Lockdown: %PRINTBIT_KIOSK_LOCKDOWN%
echo [PrintBit] USB Export Enabled: %PRINTBIT_USB_EXPORT_ENABLED%

setlocal EnableDelayedExpansion
set "PROJECT_DIR_SANITIZED=%PROJECT_DIR%"
set "PROJECT_DIR_SANITIZED=!PROJECT_DIR_SANITIZED:^^=!"
set "PROJECT_DIR_SANITIZED=!PROJECT_DIR_SANITIZED:&=!"
set "PROJECT_DIR_SANITIZED=!PROJECT_DIR_SANITIZED:|=!"
set "PROJECT_DIR_SANITIZED=!PROJECT_DIR_SANITIZED:<=!"
set "PROJECT_DIR_SANITIZED=!PROJECT_DIR_SANITIZED:>=!"
set "PROJECT_DIR_SANITIZED=!PROJECT_DIR_SANITIZED:%%=!"
if not "%PROJECT_DIR%"=="!PROJECT_DIR_SANITIZED!" (
    echo [PrintBit] ERROR: Project path contains unsupported shell metacharacters (^& ^| ^< ^> ^! %%).
    echo [PrintBit]        Use a controlled deployment path without these characters.
    pause
    exit /b 1
)
endlocal & set "PROJECT_DIR=%PROJECT_DIR_SANITIZED%"

:: Ensure node is available
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [PrintBit] ERROR: node not found. Install Node.js for this machine.
    pause
    exit /b 1
)

if "%PORT%"=="" set "PORT=3000"

if /I "%PRINTBIT_NETWORK_PROVIDER%"=="esp32" (
    if exist "%PROJECT_DIR%\scripts\ensure-esp32-network.ps1" (
        echo [PrintBit] Ensuring ESP32 Wi-Fi static IP profile in background...
        start "" /b powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_DIR%\scripts\ensure-esp32-network.ps1" -Quiet
    ) else (
        echo [PrintBit] WARNING: Missing network helper script at "%PROJECT_DIR%\scripts\ensure-esp32-network.ps1"
    )
)

if not exist "%PROJECT_DIR%\dist\server.js" (
    echo [PrintBit] Compiled server bundle missing. Building dist\server.js...
    where pnpm >nul 2>&1
    if %errorlevel% neq 0 (
        echo [PrintBit] ERROR: pnpm is required to build dist\server.js.
        echo [PrintBit]        Run "pnpm run build" once from project root.
        pause
        exit /b 1
    )
    pushd "%PROJECT_DIR%"
    call pnpm run build
    if %errorlevel% neq 0 (
        popd
        echo [PrintBit] ERROR: build failed.
        pause
        exit /b 1
    )
    popd
)

:: Start PrintBit server
echo [PrintBit] Starting compiled server...
for /f %%P in ('powershell -NoProfile -Command "$c = Get-NetTCPConnection -State Listen -LocalPort %PORT% -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $c.OwningProcess }"') do set "EXISTING_SERVER_PID=%%P"
if defined EXISTING_SERVER_PID (
    echo [PrintBit] Server already listening on port %PORT% (PID %EXISTING_SERVER_PID%). Skipping new launch.
) else (
    start "PrintBit Server" /min cmd /c "pushd ""%PROJECT_DIR%"" && node dist\server.js"
)
set "NETWORK_PROVIDER=%PRINTBIT_NETWORK_PROVIDER%"

if /I "%NETWORK_PROVIDER%"=="esp32" (
    set "LOCAL_IP=%PRINTBIT_ESP32_KIOSK_IP%"
    if "%LOCAL_IP%"=="" set "LOCAL_IP=192.168.4.2"
    echo [PrintBit] ESP32 mode detected. Using kiosk IP: %LOCAL_IP%
) else (
    call :detect_ip
    if "%LOCAL_IP%"=="" (
        echo [PrintBit] WARNING: Could not detect local IP. Falling back to localhost.
        set "LOCAL_IP=localhost"
    )
)

if "%PRINTBIT_KIOSK_HOST%"=="" (
    set "KIOSK_HOST=127.0.0.1"
) else (
    set "KIOSK_HOST=%PRINTBIT_KIOSK_HOST%"
)
set "KIOSK_URL=http://%KIOSK_HOST%:%PORT%/loading"
echo [PrintBit] Kiosk URL: %KIOSK_URL%
if not "%LOCAL_IP%"=="" echo [PrintBit] External Wi-Fi IP (for clients): http://%LOCAL_IP%:%PORT%/

set "SKIP_EDGE=0"
if /I "%PRINTBIT_SKIP_EDGE_LAUNCH%"=="1" set "SKIP_EDGE=1"
if /I "%PRINTBIT_SKIP_EDGE_LAUNCH%"=="true" set "SKIP_EDGE=1"
if /I "%PRINTBIT_SKIP_EDGE_LAUNCH%"=="yes" set "SKIP_EDGE=1"
if /I "%PRINTBIT_SKIP_EDGE_LAUNCH%"=="on" set "SKIP_EDGE=1"

if /I "%USERNAME%"=="SYSTEM" (
    echo [PrintBit] Running as SYSTEM. Skipping Edge launch in Session 0.
    echo [PrintBit] Assigned Access should open Edge for kiosk user at %KIOSK_URL%.
    goto :eof
)

if "%SKIP_EDGE%"=="1" (
    echo [PrintBit] Assigned Access kiosk session detected. Skipping managed Edge launch.
    echo [PrintBit] Assigned Access should open Edge for kiosk user at %KIOSK_URL%.
    goto :eof
)

:: Launch Edge in kiosk mode pointed at loopback
echo [PrintBit] Launching kiosk browser...
start "" msedge.exe --kiosk %KIOSK_URL% --edge-kiosk-type=fullscreen --no-first-run --no-default-browser-check --disable-infobars --disable-background-networking --disable-sync --disable-features=TranslateUI

echo [PrintBit] Kiosk started successfully at %KIOSK_URL%.
goto :eof

:detect_ip
set "LOCAL_IP="
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /R "IPv4.*192\.168\.4\."') do (
    for /f "tokens=1 delims= (" %%B in ("%%A") do set "LOCAL_IP=%%B"
    goto :detect_done
)
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /R "IPv4.*192\.168\.137\."') do (
    for /f "tokens=1 delims= (" %%B in ("%%A") do set "LOCAL_IP=%%B"
    goto :detect_done
)
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /R "IPv4.*[0-9][0-9]*\.[0-9]" ^| findstr /V /R "169\.254\."') do (
    for /f "tokens=1 delims= (" %%B in ("%%A") do set "LOCAL_IP=%%B"
    goto :detect_done
)
:detect_done
for /f "tokens=1 delims= (" %%A in ("%LOCAL_IP%") do set "LOCAL_IP=%%A"
exit /b
