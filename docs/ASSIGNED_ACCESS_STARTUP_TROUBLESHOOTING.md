# Windows Tablet Assigned Access Kiosk Boot & Loading Troubleshooting

## 1. Problem Summary

When powering on or restarting a Windows 10/11 tablet configured with Windows Assigned Access (single-app kiosk mode with Microsoft Edge) targeting `http://localhost:3000/loading` or `http://192.168.4.2:3000/loading`, the tablet immediately displays Microsoft Edge's native offline error page:
**"No internet access."** / `DNS_PROBE_FINISHED_NO_INTERNET` / `ERR_CONNECTION_REFUSED`.

Edge becomes stuck on this error page and never loads the intended bootstrap loading screen (`/loading`, backed by `src/public/loading/index.html`).

---

## 2. Root Cause Analysis

The failure is caused by three interacting layers:

### A. Windows Boot Priority & Race Condition

Assigned Access is triggered at user session logon. When the kiosk user signs in automatically upon device startup, Assigned Access launches Microsoft Edge (`msedge.exe`) within **1 to 3 seconds**.

The Node.js server (`start-kiosk-server.ps1`), scheduled at machine boot via Task Scheduler (`-AtStartup`), requires **5 to 12 seconds** to initialize PowerShell, check dependencies, launch Node.js, load native modules (`sharp`, `canvas`, `argon2`), and bind to port `3000`.

Edge attempts to fetch `http://localhost:3000/loading` before port `3000` is open. The TCP handshake is immediately rejected (`WSAECONNREFUSED`). Because Edge Kiosk mode runs without address bar, refresh button, or auto-reload for local connection failures, Edge remains permanently frozen on the offline screen.

### B. Windows AppContainer Loopback Network Isolation

Under Windows Assigned Access, Microsoft Edge runs inside an **AppContainer sandbox** (`Microsoft.MicrosoftEdge.Stable_8wekyb3d8bbwe` or `Microsoft.MicrosoftEdge_8wekyb3d8bbwe`).

By Windows security architecture, the Windows Filtering Platform (WFP) strictly forbids AppContainers from opening network sockets to local loopback addresses (`127.0.0.1`, `::1`, and `localhost`) unless an explicit loopback exemption is registered via `CheckNetIsolation.exe LoopbackExempt`.

Without this exemption, all requests from Edge in Assigned Access to local ports are blocked at the kernel network filter level, reporting "No internet access."

### C. IPv6 / IPv4 Bind Mismatch & Offline DNS Probe

The Node.js server previously bound strictly to IPv4 `0.0.0.0` (`server.listen(PORT, '0.0.0.0')`). On Windows 10/11, `localhost` resolves to IPv6 `[::1]` first. Requests to `http://localhost:3000` attempted `[::1]:3000`, which was rejected immediately.

Furthermore, on a tablet without WAN internet (or offline/hotspot mode), Chromium's DNS resolution fails and concludes with `DNS_PROBE_FINISHED_NO_INTERNET`.

If configured with `http://192.168.4.2:3000/loading`, the failure was guaranteed: `192.168.4.2` is a static IP on the Wi-Fi adapter that only exists after connecting to the ESP32 SoftAP (which takes 5 to 15 seconds after boot).

---

## 3. Tablet Boot Sequence & Priority Timeline

```text
Time      Component                       Action & State
───────────────────────────────────────────────────────────────────────────────────────
T+0.0s    Windows Kernel                  Hardware and drivers initialize.
T+1.0s    PrintBitHardware Service        C# Worker starts in background (SYSTEM).
T+2.0s    Task Scheduler                  Kiosk task triggers start-kiosk-server.ps1.
T+2.2s    Windows Autologon               printbit kiosk user account logs in.
T+3.0s    Assigned Access Shell           Launches msedge.exe to target URL.
T+3.5s    Microsoft Edge                  Hits port 3000 (CLOSED). Loopback blocked.
                                          Edge renders "No internet access" error.
T+4.0s    PowerShell                      PowerShell engine finishes loading.
T+5.0s    Node.js Process                 Node loads V8 and native binaries.
T+7.5s    Express Server                  server.listen() online on port 3000.
                                          (Edge is already stuck; never reloads).
```

---

## 4. Implemented Fixes

### Fix 1: Dual-Stack Server Listener (`src/server.ts`)

Updated `startHttpServer()` in `src/server.ts` to omit the hardcoded `'0.0.0.0'` address constraint:

```typescript
async function startHttpServer(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.listen(PORT, () => {
      const localIP = getLocalIPv4();
      if (localIP) {
        console.log(`[BOOT] HTTP server ready: http://${localIP}:${PORT}`);
      } else {
        console.log(`[BOOT] HTTP server ready on port ${PORT}`);
      }
      resolve();
    });
    server.once('error', reject);
  });
}
```

This binds to the dual-stack unspecified address (`::`), accepting connections simultaneously from IPv6 loopback (`[::1]`), IPv4 loopback (`127.0.0.1`), `localhost`, and external interfaces (`192.168.4.2`).

### Fix 2: AppContainer Loopback Exemption & Edge Policy (`scripts/apply-kiosk-lockdown.ps1`)

Configured automatic loopback exemption for Microsoft Edge packages:

```powershell
$edgePackages = @(
  'Microsoft.MicrosoftEdge.Stable_8wekyb3d8bbwe',
  'Microsoft.MicrosoftEdge_8wekyb3d8bbwe'
)
foreach ($pkg in $edgePackages) {
  CheckNetIsolation.exe LoopbackExempt -a -n="$pkg"
}
```

Whitelisted local origins under Edge Enterprise Group Policy (`LoopbackNetworkAllowedForUrls`):

- `http://127.0.0.1:3000`
- `http://localhost:3000`
- `http://192.168.4.2:3000`

### Fix 3: Startup Race Condition Resolution (`scripts/start-kiosk-server.ps1`)

`start-kiosk-server.ps1` now monitors port `3000` until the HTTP server is healthy and accepting TCP connections. If Assigned Access launched Edge before port `3000` was ready (leaving Edge on the "No internet" screen), `start-kiosk-server.ps1` detects the premature Edge instance, terminates it cleanly, and allows the Windows Assigned Access shell to relaunch Edge directly into `/loading` with port `3000` listening.

### Fix 4: Automated Verification (`scripts/verify-kiosk-lockdown.ps1` & `scripts/verify-kiosk-boot.ps1`)

Added checks confirming:

1. `CheckNetIsolation.exe LoopbackExempt` contains Microsoft Edge.
2. `HKLM:\SOFTWARE\Policies\Microsoft\Edge\LoopbackNetworkAllowedForUrls` contains loopback origins.
3. Server bundle, scheduled tasks, and port listeners are configured properly.

### Fix 5: Assigned Access URL Standard

Standardized the recommended Assigned Access URL across all documentation to:

```text
http://127.0.0.1:3000/loading
```

This avoids DNS lookups and does not depend on Wi-Fi association timing.

---

## 5. Verification Commands

Run from Administrator PowerShell:

```powershell
# 1. Verify Edge loopback exemption and lockdown policies
pnpm run lockdown:verify

# 2. Verify kiosk boot configuration
pnpm run boot:verify

# 3. Check AppContainer loopback exemption directly
CheckNetIsolation.exe LoopbackExempt -s
```
