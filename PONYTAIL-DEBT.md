# PrintBit: Wired Serial Migration & Action Plan

> **Branch:** `refactor/wired-serial-minimal-hardware`  
> **Target Architecture:** Wired USB Serial for Machine Hardware (Coins & Hopper) + Windows Mobile Hotspot for Customer Uploads.

---

## 1. Ponytail Debt & Architectural Deferrals Ledger

| Component              | What Was Cut / Simplified                                                                                               | Ceiling / Assumption                                                                       | Upgrade Trigger                                                                                           |
| :--------------------- | :---------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------- |
| **ESP32 Firmware**     | Replaced ~3,200 lines (`esp32-softAP.ino`, `esp32-wifimanager.ino`) with a clean ~220-line sketch (`esp32-serial.ino`). | ESP32 dedicated 100% to physical GPIO interrupts and USB serial communication.             | Customer phones must connect directly to the ESP32 chip instead of Windows Mobile Hotspot or venue Wi-Fi. |
| **Coin Ingestion**     | Cut HTTP `/coin` endpoint and header verification (`x-coin-api-key`, `x-coin-source`, `x-coin-event-id`).               | Hardware is locked inside the same kiosk chassis; physical USB wire is the trust boundary. | Coin acceptor is physically separated across a public TCP/IP network.                                     |
| **Hopper Control**     | Cut HTTP `/hopper/dispense` and `/hopper/status` polling.                                                               | C# Worker named pipes send `HOPPER DISPENSE <n>` and read `HOPPER DONE <n>` over COM3.     | Hopper is controlled remotely over an untrusted network.                                                  |
| **Kiosk Registration** | Cut 15-second background HTTP loop to `http://192.168.4.1/kiosk/register`.                                              | Node.js doesn't need to register its IP with the ESP32 over HTTP.                          | ESP32 softAP needs captive portal URL redirection.                                                        |

_Ledger status: 0 unmanaged code markers. Clean debt ledger._

---

## 2. Action Checklist: What You Need to Do

Follow these steps in order to test and verify the new wired architecture:

### Step 1: Flash the ESP32 Board

1. Open [`esp32-serial.ino`](file:///D:/giomj/Projects/printbit/esp32-serial.ino) in Arduino IDE.
2. Under **Tools**, select:
   - **Board:** `ESP32 Dev Module`
   - **Port:** Your ESP32 COM port (e.g. `COM3`)
   - **Upload Speed:** `921600` (or `115200`)
3. Click **Upload**.
4. Open the Arduino **Serial Monitor** at **115200 baud** to verify the startup message:
   ```text
   PRINTBIT_SERIAL_READY
   ```
5. **Close the Serial Monitor** so the COM port is freed for Windows.

---

### Step 2: Physical Hardware Connection

1. Connect the ESP32 to the Windows tablet using a secure USB data cable.
2. Connect your **Coin Acceptor** signal to **GPIO 4**.
3. Connect your **Hopper Optical Sensor** to **GPIO 19**.
4. Connect your **Hopper 12V Relay Control** to **GPIO 27**.
5. Open Windows **Device Manager** $\to$ **Ports (COM & LPT)** and note the COM port number (e.g. `COM3`).

---

### Step 3: Verify Configuration Files

#### 1. C# Worker (`printbit-worker`)

Open [`../printbit-worker/src/PrintBit.HardwareService/appsettings.json`](file:///D:/giomj/Projects/printbit-worker/src/PrintBit.HardwareService/appsettings.json#L4):

```json
"HardwareSettings": {
  "EnableCoinSimulation": false,
  "Esp32Port": "COM3",
  "Esp32BaudRate": 115200
}
```

- Ensure `"Esp32Port"` matches the COM port identified in Device Manager.
- _(Note: `HardwareOrchestrator.cs` has already been patched and compiled to forward `coin_pulse:<val>` events directly to the named pipe)._

#### 2. Node.js Backend (`printbit`)

Check [`.env`](file:///D:/giomj/Projects/printbit/.env):

```env
# Network mode: disables obsolete ESP32 HTTP registration
PRINTBIT_NETWORK_PROVIDER=windows

# Serial port configuration
PRINTBIT_SERIAL_PORT=COM3

# Hotspot credentials for customer phones
PRINTBIT_HOTSPOT_SSID=PrintBit
PRINTBIT_HOTSPOT_PASSWORD=printbit123
PRINTBIT_HOTSPOT_AUTH_TYPE=WPA
```

---

### Step 4: Turn On Customer Wi-Fi (Choice A)

On the Windows Tablet:

1. Open **Settings** ($\text{Win} + \text{I}$) $\to$ **Network & Internet** $\to$ **Mobile Hotspot**.
2. Click **Edit**:
   - **Network name (SSID):** `PrintBit`
   - **Password:** `printbit123`
3. Toggle **Mobile Hotspot** to **ON**.
   _(Windows assigns itself `192.168.137.1`, which matches the QR codes)._

---

### Step 5: Start the Services & Test

#### 1. Start the C# Hardware Service

Open a PowerShell terminal:

```powershell
cd D:\giomj\Projects\printbit-worker\src\PrintBit.HardwareService
dotnet run
```

_Expected log:_ `Serial connection opened on COM3` and `Listening for PrintBit hardware events`.

#### 2. Start the Node.js Kiosk Server

Open a second PowerShell terminal:

```powershell
cd D:\giomj\Projects\printbit
pnpm dev
```

_Expected log:_ `[HOTSPOT] Provider active: windows (ESP32 HTTP registration bypassed)`. No aborted 15-second warnings.

---

## 3. End-to-End Verification Tests

1. **Coin Accepting Test:**
   - Drop a physical coin (₱1, ₱5, ₱10, or ₱20) into the coin slot.
   - _Worker console:_ logs `Coin pulse received: X (source: ESP32)` and `Coin accepted: X`.
   - _Kiosk screen:_ The balance increments in real time on the UI.

2. **Hopper Dispensing Test (1-Peso Coins):**
   - Trigger change dispensing from the kiosk flow.
   - _Physical check:_ Relay activates GPIO 27, motor runs, 1-peso coins pass the optical sensor on GPIO 19, and the motor cuts off immediately when the target count is reached.
   - _Worker console:_ logs `Hopper dispense completed for reqId (dispensed: N)`.

3. **Mobile Phone Upload Test:**
   - Connect your smartphone Wi-Fi to **`PrintBit`** (password: `printbit123`).
   - On the kiosk screen at `http://localhost:3000/print`, scan the **Upload QR code**.
   - On your phone, select a document and tap **Upload**.
   - _Kiosk screen:_ Instantly receives the document and transitions to preview.
