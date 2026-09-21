# Wi-Fi Auto-Disconnect Specification

**Date**: 2026-09-21  
**Author**: Antigravity & User  
**Status**: Approved Design  
**Branch**: `feat/wifi-auto-disconnect`  
**Reference**: [`AUTO_DISCONNECT_MECHANISM.md`](file:///c:/Users/printbit/printbit/AUTO_DISCONNECT_MECHANISM.md)

---

## 1. Executive Summary

In the PrintBit kiosk system, customers connect to the ESP32 SoftAP Wi-Fi network (`PrintBit`) to upload documents or download scanned soft copies. Because the ESP32 SoftAP hardware has a constrained station limit (typically 4–8 stations), customers whose phones remain connected after completing their transaction exhaust available station slots. Subsequent customers cannot connect to the Wi-Fi.

This specification defines a reliable, non-intrusive **Wi-Fi Auto-Disconnect Mechanism** that deauthenticates customer devices after their transaction completes, while strictly protecting the Windows tablet (`kioskIp`) and active administrative sessions.

---

## 2. Architecture & Subsystem Boundaries

The auto-disconnect system spans three components:

```text
┌─────────────────────────────────┐
│          Customer Phone         │
│   Connected to PrintBit Wi-Fi   │
└────────────────┬────────────────┘
                 │
            Wi-Fi (192.168.4.x)
                 │
                 ▼
┌─────────────────────────────────┐           HTTP (POST /kiosk/disconnect)
│         ESP32 SoftAP            │ ◄─────────────────────────────────────────────┐
│  - SSID: PrintBit               │                                               │
│  - AP IP: 192.168.4.1           │                                               │
│  - Station list (AID & MAC)     │                                               │
│  - esp_wifi_deauth_sta(aid)     │                                               │
└────────────────┬────────────────┘                                               │
                 │                                                                │
            USB Serial                                                            │
         (Coins & Hopper)                                                         │
                 │                                                                │
                 ▼                                                                │
┌─────────────────────────────────┐                                               │
│       C# Hardware Worker        │                                               │
│  - Epson L5290 printing         │                                               │
│  - Flatbed scanner              │                                               │
│  - Hopper dispensing            │                                               │
│  (100% UNTOUCHED BY THIS SPEC)  │                                               │
└────────────────┬────────────────┘                                               │
                 │                                                                │
             Named Pipe                                                           │
       (printbit-worker-events)                                                   │
                 │                                                                │
                 ▼                                                                │
┌─────────────────────────────────────────────────────────────────────────────┐   │
│                          Windows 10 Kiosk Tablet                            │   │
│                                                                             │   │
│  Static Wi-Fi IP: 192.168.4.2 (kioskIp)                                     │   │
│                                                                             │   │
│  ┌───────────────────────────────┐     ┌─────────────────────────────────┐  │   │
│  │    Node.js Backend (:3000)    │     │      Frontend Kiosk UI          │  │   │
│  │  - Captures customerIp        │ ◄───┤  - confirm/app.ts               │  │───┘
│  │  - POST /api/.../disconnect   │     │  - Thank You countdown (15s/30s)│  │
│  │  - Calls ESP32 disconnect API │     │  - Done vs Print Another File   │  │
│  └───────────────────────────────┘     └─────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Subsystem Roles
1. **ESP32 Firmware (`esp32-softAP.ino`)**:
   - Manages the Wi-Fi AP.
   - Exposes an authenticated route `POST /kiosk/disconnect` requiring `kioskRegisterToken`.
   - Maps `targetIp` to station AID and calls `esp_wifi_deauth_sta(aid)`.
   - Enforces the **Hardware Whitelist**: rejects any attempt to disconnect `kioskIp` or `apIp`.
2. **Node.js Kiosk Server**:
   - Captures `customerIp` from the incoming socket during upload or portal interaction.
   - Exposes `POST /api/wireless/sessions/:id/disconnect` and `POST /api/hotspot/disconnect-customer`.
   - Sends the deauthentication command to the ESP32 (`http://192.168.4.1/kiosk/disconnect`).
3. **Kiosk UI (`src/public/confirm/app.ts`)**:
   - Manages the post-print Thank You modal.
   - Runs a 15-second grace countdown (30 seconds for Scan mode).
   - Aborts countdown if the customer taps **"Print Another File"**.
   - Fires disconnect and navigates to `/` when the customer taps **"Done"** or the timer expires.
4. **C# Worker**:
   - **Zero changes.** Operates unchanged over USB Serial and named pipes.

---

## 3. Detailed Component Design

### 3.1. ESP32 Firmware (`esp32-softAP.ino`)

#### New Helper Function: `disconnectStationByIp`
```cpp
bool disconnectStationByIp(const String& ipStr) {
  IPAddress targetIp;
  if (!targetIp.fromString(ipStr)) return false;

  // SAFETY: Never disconnect the ESP32 AP or the Kiosk PC
  if (targetIp == apIp || (kioskIp.length() > 0 && ipStr == kioskIp)) {
    Serial.println("kiosk_disconnect_rejected:target_is_kiosk_or_ap");
    return false;
  }

  wifi_sta_list_t stationList;
  memset(&stationList, 0, sizeof(stationList));
  if (esp_wifi_ap_get_sta_list(&stationList) != ESP_OK) return false;

  for (int i = 0; i < stationList.num; i++) {
    IPAddress stationIp;
    if (getStationIpByMac(stationList.sta[i].mac, stationIp) && stationIp == targetIp) {
      uint16_t aid = 0;
      if (esp_wifi_ap_get_sta_aid(stationList.sta[i].mac, &aid) == ESP_OK && aid > 0) {
        esp_wifi_deauth_sta(aid);
        Serial.print("kiosk_disconnect:success:ip=");
        Serial.println(ipStr);
        return true;
      }
    }
  }
  return false;
}
```

#### New Route: `POST /kiosk/disconnect`
- **Path**: `/kiosk/disconnect`
- **Method**: `POST`
- **Auth**: Requires `token == kioskRegisterToken` (value `"printbit-register-token"`).
- **Parameters**: `ip` (string).
- **Behavior**:
  - If `ip` is specified and valid: calls `disconnectStationByIp(ip)`.
  - If `ip` is `"all_customers"` or empty: calls `disconnectAllStationsExcept(kioskIp)`.
- **Response**: `200 OK` JSON `{"ok": true, "message": "Customer station deauthenticated"}` or `401 Unauthorized` / `400 Bad Request`.

---

### 3.2. Node.js Backend

#### Hotspot Service Helper (`src/services/hotspot.ts`)
```ts
export async function disconnectCustomerFromEsp32(customerIp?: string): Promise<boolean> {
  const requestUrl = new URL('/kiosk/disconnect', `${ESP32_AP_BASE_URL}/`);
  const payload = new URLSearchParams({
    token: ESP32_REGISTER_TOKEN,
    ip: customerIp?.trim() ?? '',
  });

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 2500);

  try {
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: payload.toString(),
      signal: abortController.signal,
    });
    return response.ok;
  } catch (error) {
    console.warn(`[HOTSPOT] ⚠ Customer disconnect request failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
```

#### Session Customer IP Tracking (`src/services/session.ts` & `wireless-session.service.ts`)
1. Extend `Session` interface with `customerIp?: string`.
2. In `uploadToSession`:
   ```ts
   const rawIp = req.socket.remoteAddress || req.ip || '';
   const normalizedIp = rawIp.replace(/^.*:/, ''); // strip IPv6 prefix if present
   if (normalizedIp) {
     this.deps.sessionStore.setCustomerIp(sessionId, normalizedIp);
   }
   ```
3. In `wireless-session.controller.ts`:
   Add `POST /api/wireless/sessions/:sessionId/disconnect`:
   - Looks up `session.customerIp`.
   - Calls `disconnectCustomerFromEsp32(customerIp)`.
   - Records an administrative event in the audit log (`"customer_wifi_disconnected"`).
   - Returns `{ ok: true }`.
4. Add generic `POST /api/hotspot/disconnect-customer`:
   - Used for fallback cleanup when no upload session exists (e.g. Copy mode completion or idle reset).

---

### 3.3. Kiosk Frontend UI (`confirm/app.ts` & `confirm/index.html`)

#### Modal Enhancements
1. Update `#thankYouDoneBtn` to show a live countdown timer:
   - Initial label: `Done (15s)` (or `Done (30s)` for Scan mode).
   - Updates every second.
2. Under the buttons, render a caption:
   `Wi-Fi automatically disconnects when finished`

#### Control Flow in `confirm/app.ts`
1. When the Thank You overlay is shown:
   - Start an interval timer ticking down from 15 seconds (30s for Scan).
2. If the customer clicks **"Print Another File"**:
   - `clearInterval(completionTimer)`.
   - Do NOT fire disconnect.
   - Navigate to `/print` (retaining session storage for remaining files).
3. If the customer clicks **"Done"**:
   - `clearInterval(completionTimer)`.
   - Fire `fetch(disconnectUrl, { method: 'POST', keepalive: true })`.
   - `clearConfirmSessionStorage()`.
   - `navigateWithKioskMotion('/')`.
4. If countdown reaches `0`:
   - Fire `fetch(disconnectUrl, { method: 'POST', keepalive: true })`.
   - `clearConfirmSessionStorage()`.
   - `navigateWithKioskMotion('/')`.

---

## 4. Safety Guarantees & Edge Cases

| Scenario | Behavior |
| :--- | :--- |
| **Strict Ordering** | Wi-Fi disconnect is **never** initiated until print/scan is finished, payment is saved, earnings are updated, and the Thank You screen is active. |
| **Kiosk Tablet Whitelist** | ESP32 firmware rejects deauthentication of `kioskIp` (`192.168.4.2`) or `apIp` (`192.168.4.1`). The tablet remains permanently connected. |
| **Admin Device Protection** | Devices with an active admin bearer session are verified and excluded from disconnect sweeps. |
| **Multiple Files to Print** | Tapping "Print Another File" immediately clears the countdown and preserves the connection. |
| **Scan Mode Soft Copy** | Scan mode gets an extended 30-second countdown so the customer has time to aim camera, open URL, and download their PDF before disconnection. |
| **Kiosk Abandonment** | If a customer leaves during upload or configuration, existing idle timeout resets to `/` and triggers a cleanup sweep of orphan stations. |
| **Network or ESP32 Latency** | Frontend uses `keepalive: true` on `fetch` with no blocking `await`. The UI returns to `/` instantaneously without freezing. |

---

## 5. Verification Plan

### Automated Unit & Integration Tests
1. **Node.js Service Tests (`test/unit/services/hotspot.test.ts`)**:
   - `disconnectCustomerFromEsp32()` succeeds with 200 from ESP32.
   - Handles network timeouts and 4xx/5xx responses gracefully without throwing.
2. **Session IP Tracking Tests (`test/unit/modules/wireless-session/wireless-session.service.test.ts`)**:
   - Verify `customerIp` is captured during `uploadToSession`.
   - Verify `POST /api/wireless/sessions/:id/disconnect` calls the hotspot disconnect service with the stored IP.
3. **Kiosk UI Tests**:
   - Verify countdown interval management (cleared on "Print Another File", triggered on "Done", triggered on 0s).

### Manual Hardware & Integration Verification
1. Connect mobile phone to `PrintBit` Wi-Fi $\rightarrow$ upload document $\rightarrow$ proceed to confirm $\rightarrow$ pay $\rightarrow$ observe Thank You screen with countdown.
2. Verify phone Wi-Fi deauthenticates within 1 second of tapping "Done" (or at 0s countdown).
3. Verify Windows tablet Wi-Fi connection is uninterrupted throughout.
4. Verify next customer can immediately associate and connect to Wi-Fi.
