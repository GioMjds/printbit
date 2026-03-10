@echo off
:: ─────────────────────────────────────────────────────────────────
:: PrintBit — Double-click launcher
:: Runs start-kiosk.ps1 with auto-elevation.
:: No need to open PowerShell manually.
:: ─────────────────────────────────────────────────────────────────
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-kiosk.ps1"