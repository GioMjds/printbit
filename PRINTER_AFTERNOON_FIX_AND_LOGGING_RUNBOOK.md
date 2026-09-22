# PrintBit Kiosk: Afternoon Printer Freeze & Unified Logging Runbook

This runbook is your complete, step-by-step guide to resolve the **afternoon print queue freeze** on your physical PrintBit kiosk and implement **real-time unified logging** across Node.js, the C# Worker, and the ESP32 inside the `@src/public/admin` panel.

---

## 1. Executive Summary: Why It Fails Every Afternoon

In a deployed kiosk machine running on a **Windows 10 tablet** connected via USB to an **Epson EcoTank L5290**, afternoon failures where **"all documents get stuck in the print queue"** occur due to three interacting power-saving mechanisms:

1. **Epson EcoTank Auto Power-Off Timer (Factory Default):**
   Epson EcoTank printers ship with a firmware feature that turns off the printer after 4 to 8 hours of inactivity or uptime. If the kiosk starts in the morning (e.g. 8:00 AM), by 12:00 PM – 2:00 PM the printer silently powers down or enters deep standby.
2. **Windows 10 USB Selective Suspend:**
   Windows tablets aggressively conserve battery and thermals by cutting power to idle USB ports. Once suspended, the virtual USB print port (`USB001` or `Epson Port`) severs communication.
3. **Queue Head-of-Line Blocking:**
   When SumatraPDF / C# Worker dispatches a document to a frozen USB port, the Windows Print Spooler (`spoolsv.exe`) pauses the document in `C:\Windows\System32\spool\PRINTERS`. Because Windows print queues are strictly FIFO (First In, First Out), **every subsequent job gets stuck in the queue behind it**.

---

## 2. On-Site Fix Checklist for Tomorrow (With the Printer)

Follow these steps in order when you are physically in front of the kiosk and the printer:

### Step 1: Epson L5290 Hardware Settings (On Printer LCD Screen)

You must change these firmware settings on the printer's physical control panel so it **never sleeps or shuts down**:

1. Turn on the printer.
2. On the printer LCD screen, navigate to:
   - **Settings** (Gear icon) -> **Device Settings** (or **Common Settings**).
   - Scroll down to **Eco Mode** or **Power Off Settings**.
3. Configure the following:
   - **Power Off if Inactive:** Set to **Off** (or **Never**).
   - **Power Off if Disconnected:** Set to **Off** (or **Never**).
   - **Sleep Timer:** Increase to **60 minutes** (or maximum allowable).
   - **Power Off Timer:** Set to **Off**.
4. Confirm changes and exit back to the printer home screen.

---

### Step 2: Windows 10 Host Power & USB Hardening (Run the Remediation Script)

An automated script has been created in the repository to eliminate manual registry edits.

1. Open PowerShell on the tablet as **Administrator**.
2. Run the remediation script:
   ```powershell
   cd C:\Users\printbit\printbit
   powershell -ExecutionPolicy Bypass -File .\scripts\fix-printer-power-and-spooler.ps1
   ```
3. What this script does automatically:
   - Sets Windows Active Power Scheme USB Selective Suspend to **Disabled** (for both AC plugged-in and Battery).
   - Sets Tablet Sleep timeout to **Never** (`0`).
   - Disables Windows Hibernation (`powercfg /h off`).
   - Disables power-down flags on all USB Hubs in the Windows registry (`DeviceSelectiveSuspended = 0`, `AllowIdleIrpInD3 = 0`).
   - Flushes stuck `.SPL` and `.SHD` files from `C:\Windows\System32\spool\PRINTERS`.
   - Restarts the Windows Print Spooler service.

#### Manual Verification in Device Manager:

1. Press `Win + X` -> select **Device Manager** (`devmgmt.msc`).
2. Expand **Universal Serial Bus controllers**.
3. Right-click each **USB Root Hub** and **Generic USB Hub** -> click **Properties**.
4. Switch to the **Power Management** tab:
   - **Uncheck** _"Allow the computer to turn off this device to save power"_.
   - Click **OK**.

---

### Step 3: Disable Epson Status Monitor 3 GUI Popups (Prevent Session 0 Freezes)

> **Important Note on Error Reporting:**
> Disabling the GUI popups does **NOT** disable error detection in Node.js or the C# Worker!
>
> - The C# Worker detects errors (Paper Out, Paper Jam, Door Open, Offline, Job Errors) through Windows **WMI (`Win32_Printer.DetectedErrorState`)** and native **WinSpool APIs (`GetPrinter`)**.
> - Node.js translates these numeric states via [`translateHardwarePrinterError`](file:///C:/Users/printbit/printbit/src/services/printer-error-translation.ts) into kiosk customer prompts (`PAPER_TRAY_EMPTY`, `PAPER_JAM_PRINT`, `PRINTER_DOOR_OPEN`, etc.).
> - What we are disabling is ONLY the intrusive desktop modal dialog (`e_yarnyre.exe`). Because the C# Worker runs as a Windows Service under `LocalSystem` in **Session 0**, interactive desktop popups cannot be seen or dismissed by anyone, causing the print spooler thread to hang indefinitely!

#### Recommended Driver Settings:

1. On the tablet, open **Control Panel** -> **Devices and Printers** (or press `Win + R` and run `shell:PrintersFolder`).
2. Right-click **EPSON L5290 Series** -> select **Printing Preferences**.
3. Go to the **Maintenance** tab.
4. Click **Extended Settings** (or **Monitoring Preferences** at the bottom).
5. Configure:
   - **Notification Dialogs:** Uncheck / disable "Desktop Notification" or select **"Do not show notification dialogs"**.
   - (Alternative if option unavailable): Uncheck **"Enable EPSON Status Monitor 3"**.
6. Click **OK** and **Apply**.

This ensures background status queries remain active while preventing unclosable GUI dialogs from freezing the print spooler queue.

---

## 3. Real-Time Unified Logging in the Admin Panel (`src/public/admin`)

### Why Logs are Currently Invisible

- **C# Worker:** Runs as a Windows Service (`PrintBitHardware`). In .NET Windows services, `Console.WriteLine` and `ILogger` console output are discarded in Session 0. No file logger provider (like Serilog or NLog) was configured.
- **Node.js:** Runs in the background via scheduled tasks without redirecting standard console streams to the database; only explicit financial/session events hit `adminLogStore`.
- **ESP32:** Logs only to hardware UART TX/RX pins (`Serial.println` at 115200 baud).

### Architecture for Real-Time Unified Logs

The admin panel at `src/public/admin/logs` can stream all three components live via the existing architecture:

```
┌─────────────────┐       ┌──────────────────────┐       ┌─────────────────┐
│     Node.js     │       │      C# Worker       │       │      ESP32      │
│  (HTTP / App)   │       │ (Hardware & Spooler) │       │ (Serial / HTTP) │
└────────┬────────┘       └──────────┬───────────┘       └────────┬────────┘
         │                           │                            │
         │                           │ Named Pipe                 │ COM3 Serial
         │                           │ (printbit-worker-events)   │ or HTTP bridge
         ▼                           ▼                            ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │                     Node.js Log Aggregation Hub                         │
 │  - Normalizes: [NODE], [WORKER], [ESP32], [SPOOLER]                     │
 │  - Stores entries in SQLite via adminService.appendAdminLog(...)        │
 │  - Broadcasts live entries via Socket.io ('admin:new_log')              │
 └────────────────────────────────────┬────────────────────────────────────┘
                                      │ WebSocket
                                      ▼
             ┌──────────────────────────────────────────────────┐
             │       Admin Console (src/public/admin/logs)      │
             │   - Live auto-updating log feed                  │
             │   - Filter buttons: [All] [Node] [Worker] [ESP32]│
             │   - Color-coded severity badges                  │
             └──────────────────────────────────────────────────┘
```

### Blueprint Code Changes to Enable Streaming:

#### 1. C# Worker: Forward Log Messages to Node.js Pipe

In `C:\Users\printbit\printbit-worker\src\PrintBit.Hardware\Devices\ESP32\SerialHostedService.cs`:
When the worker receives lines from the ESP32 COM port, emit them to the return pipe client:

```csharp
// When ESP32 sends a serial line
await _eventPipe.SendEventAsync(new WorkerPrintEvent
{
    Type = "HardwareStatus",
    Message = $"[ESP32] {receivedLine}",
    TimestampUtc = DateTime.UtcNow.ToString("o")
});
```

#### 2. Node.js: Append Worker & ESP32 Events to Admin Log Store

In `src/services/worker-return-pipe.ts` and `src/server.ts`:

```typescript
// Inside onEvent handler in server.ts
if (
  evt.type === 'HardwareStatus' ||
  evt.type === 'PrinterError' ||
  evt.type === 'PrinterOffline'
) {
  void adminService
    .appendAdminLog(
      evt.type === 'PrinterError' ? 'printer_error' : 'hardware_event',
      evt.message ?? evt.errorMessage ?? `Worker event: ${evt.type}`,
      { source: evt.type.includes('ESP32') ? 'ESP32' : 'Worker' },
    )
    .then((entry) => {
      io.emit('admin:new_log', entry);
    });
}
```

#### 3. Admin UI: Live Socket.io Listener in `src/public/admin/logs/app.ts`

Add a live Socket.io listener so the table updates without needing manual page refreshes:

```typescript
import { io } from 'socket.io-client';

const socket = io();
socket.on('admin:new_log', (logEntry) => {
  allLogs.unshift(logEntry);
  totalLogs = allLogs.length;
  renderPage();
});
```

---

## 4. Verification Test Tomorrow (Run Once Everything is Plugged In)

1. **Verify Physical Connectivity:**
   - Plug Epson USB into tablet.
   - Power on the printer.
   - Run `Get-PnpDevice -Class "Printer" -Status OK` in PowerShell. Ensure Epson is listed.

2. **Run Test Print via SumatraPDF:**
   - Open PowerShell as Admin and execute:
     ```powershell
     & "C:\Users\printbit\bin\SumatraPDF.exe" -print-to "EPSON L5290 Series" -silent "C:\Users\printbit\printbit\uploads\test.pdf"
     ```
   - Verify paper feeds and prints.

3. **Check Windows Spooler Queue Status:**

   ```powershell
   Get-PrintJob -PrinterName "EPSON L5290 Series"
   ```

   - Ensure the queue drops back to 0 pending jobs.

4. **Verify Admin Logs:**
   - Open browser to `http://localhost:3000/admin/logs`.
   - Log in with your admin PIN.
   - Verify that log entries are visible and show recent timestamps.
