Yes. With the additional detail that Assigned Access opens:

```text
http://127.0.0.1:3000/loading
```

the problem becomes much clearer.

## The important distinction

Your slow kiosk startup and your unreliable mDNS are **related to the ESP32 network environment, but they are not the same problem**.

`127.0.0.1` is Windows loopback:

```text
Edge
  ↓
127.0.0.1:3000
  ↓
Node.js on the same tablet
```

No Wi-Fi, ESP32, router, mDNS, DNS, or gateway is required for that HTTP connection.

So if this URL:

```text
http://127.0.0.1:3000/loading
```

appears quickly but PrintBit remains on the loading screen for several seconds, then **Express itself is not loading slowly**.

Your `/loading` page is deliberately polling `/api/startup/ready` every 1.5 seconds and does not proceed until the Node startup sequence declares itself ready.

And I found several operations in the current PrintBit startup path that explain exactly why ESP32 Wi-Fi can be slower than a router.

# Likely root cause

I would rank the causes like this:

| Suspect                    | Router                        | ESP32 SoftAP                      |                           Likelihood |
| -------------------------- | ----------------------------- | --------------------------------- | -----------------------------------: |
| NTP/trusted-time check     | Fast, internet available      | Times out/no internet             |                        **Very high** |
| ESP32 registration request | Different route behavior      | Waits on ESP32 HTTP response      |                             **High** |
| ESP32 network enforcement  | Usually irrelevant            | Can reconnect/reconfigure adapter |                             **High** |
| mDNS multicast reliability | Router handles multicast well | SoftAP can lose multicast         | **High for `.local`, not localhost** |
| Express/Node performance   | Same computer                 | Same computer                     |                                  Low |
| `127.0.0.1` itself         | Always local                  | Always local                      |                     Essentially none |

## 1. Your startup waits for an NTP check

This stood out immediately in your current `server.ts`.

During startup PrintBit does:

```ts
const startupTrustedTime = await verifyTrustedClockSync();
```

before eventually calling:

```ts
markStartupReady();
```

Your trusted-time implementation invokes Windows `w32tm`, including a network operation similar to:

```text
w32tm /stripchart /computer:<NTP server> /samples:1 /dataonly
```

with a **3-second timeout**.

This creates exactly this behavior:

```text
Connected to router
        ↓
Internet available
        ↓
time.windows.com / NTP reachable
        ↓
verification completes quickly
        ↓
markStartupReady()
        ↓
homepage
```

Whereas with the ESP32:

```text
Connected to PrintBit ESP32
        ↓
192.168.4.x LAN only
        ↓
NO INTERNET
        ↓
Windows attempts NTP
        ↓
wait...
wait...
timeout
        ↓
startup continues
```

Espressif explicitly describes SoftAP as a local access point that does not inherently provide external Internet connectivity. ([Espressif Systems][1])

This is therefore my **first suspect for the router-versus-ESP32 startup difference**.

And there is another important detail in your code: trusted-time enforcement is already designed to default to disabled because kiosks may run with limited/offline connectivity.

That makes blocking the entire kiosk startup on an NTP probe questionable.

---

# 2. You're also blocking readiness on ESP32 registration

There is another network wait.

Your hotspot service defines:

```ts
const ESP32_REGISTER_TIMEOUT_MS = 2_500;
```

and `registerKioskWithEsp32()` sends an HTTP request to:

```text
ESP32_AP_BASE_URL/kiosk/register
```

using a 2.5-second abort timeout.

Then:

```ts
await this.startEsp32RegistrationLoop();
```

ultimately occurs inside:

```ts
await startHotspot();
markStartupReady();
```

So your startup sequence effectively contains:

```text
localhost server starts
        ↓
database
        ↓
C# worker IPC
        ↓
recovery
        ↓
NTP/network verification        ← potentially slow
        ↓
other startup work
        ↓
ESP32 HTTP registration         ← potentially another 2.5 sec
        ↓
markStartupReady()
        ↓
/loading leaves loading screen
```

This is why changing Edge from `192.168.4.2` to `127.0.0.1` does **not necessarily eliminate the delay**.

The browser connection is local, but the **readiness gate is waiting on network-dependent services**.

---

# 3. Your ESP32 network setup script can also delay startup

Your `start-kiosk.ps1` runs:

```powershell
ensure-esp32-network.ps1
```

before starting the Node server when the network provider is ESP32.

And your current network script defaults to:

```powershell
WaitSeconds = 10
RetryCount = 3
```

It can:

```text
netsh wlan connect
↓
wait for PrintBit SSID
↓
set static 192.168.4.2
↓
set gateway
↓
set DNS
↓
sleep
↓
verify
↓
retry if needed
```

There is something I would change here.

Even if the tablet is already correctly connected as:

```text
Wi-Fi
SSID: PrintBit
IPv4: 192.168.4.2
Mask: 255.255.255.0
Gateway: 192.168.4.1
```

your script can still go through connection/configuration operations.

For kiosk deployment, this should be **idempotent**:

```text
Already connected?
        ↓ yes

Already 192.168.4.2?
        ↓ yes

Correct gateway?
        ↓ yes

RETURN IMMEDIATELY
```

instead of reapplying networking.

---

# Why mDNS is also worse on ESP32

This is a separate issue.

mDNS uses multicast UDP. Espressif's mDNS implementation uses multicast for `.local` hostname and service discovery. ([Espressif Systems][2])

A normal router/access point is generally much better equipped to handle:

```text
224.0.0.251
UDP 5353
mDNS queries/responses
multicast forwarding
multiple clients
power saving
```

than an ESP32 acting as SoftAP.

More importantly, Espressif explicitly documents a SoftAP limitation: multicast frames may be lost when connected stations use Wi-Fi power saving because the ESP32 AP does not cache multicast traffic the same way it caches unicast traffic. ([Espressif Systems][3])

That fits your symptom extremely well:

```text
Router:
printbit.local
    ↓
usually resolves immediately

ESP32 SoftAP:
printbit.local
    ↓
mDNS query
    ↓
multicast packet occasionally lost
    ↓
retry
    ↓
sometimes resolves
sometimes doesn't
```

So I would **not make mDNS a critical PrintBit infrastructure dependency** when using the ESP32 as the AP.

Use it as a convenience alias.

---

# What PrintBit should ultimately use

For the kiosk tablet itself:

```text
http://127.0.0.1:3000/
```

Correct. Keep this.

For clients connected to PrintBit Wi-Fi:

```text
http://192.168.4.2:3000/
```

This should be your deterministic fallback.

For convenience:

```text
http://printbit.local:3000/
```

or:

```text
http://printbit-admin.local/admin
```

can exist, but PrintBit shouldn't become unusable if mDNS fails.

Your ESP32 captive portal can also direct clients to the known kiosk address:

```text
ESP32
192.168.4.1
     │
     ├── captive portal
     │
     └── knows kiosk → 192.168.4.2:3000
```

That is substantially more deterministic than relying entirely on multicast discovery.

---

# What I recommend changing

I would do these in this order:

1. **Prove which startup stage is slow.** While connected to the router and then ESP32, run:

```powershell
curl.exe -s -o NUL -w "loading=%{time_total}s`n" http://127.0.0.1:3000/loading

curl.exe -i http://127.0.0.1:3000/api/startup/ready

w32tm /query /status

w32tm /stripchart /computer:time.windows.com /samples:1 /dataonly
```

If `/loading` returns immediately while `/api/startup/ready` says:

```json
{
  "ready": false,
  "phase": "booting"
}
```

you have definitively proven that **Wi-Fi is not slowing Express or loopback**. Something inside your startup readiness sequence is waiting.

Then compare:

```powershell
Measure-Command {
    w32tm /stripchart /computer:time.windows.com /samples:1 /dataonly
}
```

on router versus ESP32.

I expect a very obvious difference.

Also run:

```powershell
curl.exe --max-time 3 http://192.168.4.1/
```

while connected to PrintBit. That tells us whether communication with the ESP32 HTTP server itself is slow.

And inspect:

```powershell
ipconfig /all
Get-NetConnectionProfile
Get-NetIPConfiguration
```

2. **Remove NTP from the critical startup path.** Because PrintBit is explicitly offline-first, `verifyTrustedClockSync()` should not delay kiosk readiness when:

```env
PRINTBIT_TRUSTED_TIME_ENFORCE=false
```

Instead of making this part of the boot gate:

```ts
const startupTrustedTime = await verifyTrustedClockSync();
```

I would move trusted-time synchronization into a degraded/background health service.

Conceptually:

```ts
markStartupReady();

void verifyTrustedClockSync()
  .then(...)
  .catch(...);

startTrustedTimeMonitor();
```

There is one caveat: your recovery logic currently runs around this trusted-time operation, so I would preserve trusted-time verification synchronously only when recovery actually needs trusted timestamps or `PRINTBIT_TRUSTED_TIME_ENFORCE=true`.

The resulting architecture should be:

```text
Essential startup
──────────────────────
Database
C# IPC
printer/hardware baseline
local HTTP
recovery state

        ↓

KIOSK READY

        ↓

Background/degraded services
────────────────────────────
NTP verification
mDNS
ESP32 re-registration
internet availability
telemetry
nonessential health checks
```

3. **Make ESP32 registration non-blocking.** Right now initial registration can delay readiness by its HTTP timeout.

Instead of:

```ts
await this.startEsp32RegistrationLoop();
```

the registration service should start asynchronously and report:

```text
healthy
degraded
offline
```

through your watchdog.

For example, conceptually:

```ts
void this.startEsp32RegistrationLoop().catch((error) => {
  // mark hotspot/network state degraded
});
```

The kiosk itself should still become ready.

The only reason to block would be if PrintBit literally cannot operate without the ESP32 registration. With your architecture, that's not true for displaying the kiosk UI.

4. **Make `ensure-esp32-network.ps1` return immediately when configuration is already correct.** You already have `Test-StaticIpProfile()`. Use it **before** running the configuration steps.

The desired behavior is essentially:

```powershell
$wifiInterface = Get-ConnectedWifiInterfaceName -Ssid $ssid

if ($wifiInterface) {
    if (Test-StaticIpProfile `
        -InterfaceAlias $wifiInterface `
        -IpAddress $kioskIp `
        -Gateway $gateway) {

        Write-NetworkLog "ESP32 network already configured correctly."
        return
    }
}

# Only do netsh/reconfiguration from here
```

That avoids resetting a perfectly good interface every boot.

5. **Treat mDNS as optional.** Leave:

```text
printbit-admin.local
```

available, but every workflow should have the static-IP fallback:

```text
192.168.4.2:3000
```

For the tablet itself, never use mDNS:

```text
127.0.0.1:3000
```

is superior.

You can also test whether Windows Wi-Fi power management is contributing to your mDNS losses:

```powershell
Get-NetAdapterPowerManagement -Name "Wi-Fi"
```

As a controlled test only, you can temporarily disable Wi-Fi adapter power management:

```powershell
Disable-NetAdapterPowerManagement -Name "Wi-Fi"
```

Then repeatedly test the `.local` address. If mDNS becomes substantially more reliable, you have evidence that ESP32 SoftAP multicast plus client power management is part of the issue.

---

# What I think is actually happening

Your system is probably doing something close to this:

```text
                    ROUTER
                      │
             Internet available
                      │
      ┌───────────────┴──────────────┐
      │                              │
 mDNS reliable                  NTP responds
      │                              │
      └──────────┬───────────────────┘
                 │
            Node startup
                 │
          markStartupReady()
                 │
              FAST
```

versus:

```text
                  ESP32 SoftAP
                       │
                local network only
                       │
           ┌───────────┴────────────┐
           │                        │
    mDNS multicast             no Internet
    less reliable                   │
           │                    NTP timeout
           │                        │
           │              ESP32 registration
           │                    may wait
           │                        │
           └───────────┬────────────┘
                       │
                 markStartupReady()
                       │
                     SLOW
```

And importantly:

```text
127.0.0.1:3000/loading
```

is sitting entirely to the side of that network path.

The `/loading` HTML isn't really waiting for the ESP32. **Your startup state machine is.**

## Architecture I would target

```text
                          WINDOWS TABLET
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│ Edge Assigned Access                                       │
│       │                                                     │
│       ▼                                                     │
│ 127.0.0.1:3000 ──────► Node.js / Express                  │
│                              │                              │
│                              ├──── named pipe ──► C# Worker │
│                              │                              │
│                              └──── serial ──────► ESP32     │
│                                                             │
│ Wi-Fi: 192.168.4.2                                         │
└──────────────────────┬──────────────────────────────────────┘
                       │
                  Wi-Fi / unicast
                       │
              ┌────────▼────────┐
              │ ESP32 SoftAP    │
              │ 192.168.4.1     │
              └────────┬────────┘
                       │
               phones / admin
                       │
              192.168.4.2:3000
                       │
                mDNS optional
```

That separates **local kiosk availability** from **network availability**, which is exactly what an offline-first kiosk should do.

Based on the current repository, I would investigate the delay in this order: **`verifyTrustedClockSync()` first, `startHotspot()`/ESP32 registration second, and `ensure-esp32-network.ps1` third**. Your mDNS inconsistency is real too, but it should not be capable of delaying `127.0.0.1:3000/loading` once those startup dependencies are decoupled.

[1]: https://docs.espressif.com/projects/esp-techpedia/en/latest/esp-friends/get-started/case-study/wifi-examples/softap-example.html?utm_source=chatgpt.com "SoftAP Example - - — ESP-Techpedia latest documentation"
[2]: https://docs.espressif.com/projects/esp-protocols/mdns/docs/latest/en/index.html?utm_source=chatgpt.com "mDNS Service - ESP32 - — ESP-Protocols latest documentation"
[3]: https://docs.espressif.com/projects/esp-idf/en/v4.3.1/esp32/api-guides/wifi.html?utm_source=chatgpt.com "Wi-Fi Driver - ESP32 - — ESP-IDF Programming Guide v4.3.1 documentation"

Chat: _Or deliberately, the `/loading` will initiate first then others may prepare in the background. In that way, the Node runs immediately in kiosk mode while truly awaiting to others to initialize._

Yes. That is the better startup model for PrintBit.

Your `/loading` page should be the **first usable surface**, not the final reward after every subsystem finishes initializing.

The desired sequence is:

```text
Node process starts
        ↓
Express binds 127.0.0.1:3000 immediately
        ↓
/loading becomes available immediately
        ↓
Edge Assigned Access displays /loading
        ↓
background initialization begins
        │
        ├── Database
        ├── C# Worker IPC
        ├── Printer detection
        ├── Scanner detection
        ├── ESP32 communication
        ├── ESP32 registration
        ├── recovery reconciliation
        ├── trusted time / NTP
        ├── watchdog
        └── other services
        ↓
required components become ready
        ↓
/loading receives ready=true
        ↓
navigate to homepage
```

That gives you the behavior you're describing: **Node and kiosk mode appear immediately**, while the loading screen truthfully represents actual initialization.

### The important distinction

You should separate:

```text
HTTP SERVER READY
```

from:

```text
PRINTBIT OPERATIONALLY READY
```

The first should happen almost immediately.

The second can take several seconds.

Right now your architecture already partially does this because `server.listen()` happens before much of your initialization. The problem is that `/loading` only has a broad state like:

```ts
phase: 'booting' | 'ready' | 'failed'
```

I would make it component-aware instead.

For example:

```ts
type ComponentState =
  | 'pending'
  | 'initializing'
  | 'ready'
  | 'degraded'
  | 'failed';

interface StartupState {
  server: ComponentState;
  database: ComponentState;
  worker: ComponentState;
  printer: ComponentState;
  scanner: ComponentState;
  esp32: ComponentState;
  trustedTime: ComponentState;
  recovery: ComponentState;

  ready: boolean;
}
```

Then `/api/startup/ready` could return something like:

```json
{
  "ready": false,
  "phase": "booting",
  "components": {
    "server": "ready",
    "database": "ready",
    "worker": "ready",
    "printer": "initializing",
    "scanner": "initializing",
    "esp32": "initializing",
    "trustedTime": "degraded",
    "recovery": "ready"
  }
}
```

Your loading page can then display something meaningful such as:

```text
Starting PrintBit

✓ Local server
✓ Database
✓ Hardware worker
● Detecting printer
● Connecting to ESP32
○ Checking scanner
⚠ Internet time unavailable

Preparing kiosk...
```

### Do not wait for everything

This is the critical design decision.

Not every service should block access to the kiosk.

I would classify PrintBit services approximately like this:

| Component               |                    Block homepage? |
| ----------------------- | ---------------------------------: |
| Express/local HTTP      |                                Yes |
| Database                |                                Yes |
| C# Worker IPC           |                                Yes |
| Recovery reconciliation |                        Usually yes |
| Printer detection       |                 Yes for Print/Copy |
| Scanner detection       |        No for Print-only operation |
| ESP32 serial/payment    |          Yes for paid transactions |
| ESP32 HTTP registration |                             **No** |
| mDNS                    |                             **No** |
| NTP/trusted time        | **No**, unless enforcement enabled |
| Internet access         |                             **No** |
| Watchdog initialization |                      Preferably no |
| Admin remote discovery  |                                 No |

This means there are actually three useful states:

```text
BOOTING
   ↓
OPERATIONAL
   ↓
FULLY HEALTHY
```

For example:

```text
Printer ✓
Worker ✓
Database ✓
ESP32 serial ✓
NTP ✗
mDNS ✗

Result:

PrintBit = OPERATIONAL
Network services = DEGRADED
```

The kiosk should still open.

### Background initialization pattern

Instead of doing everything serially:

```ts
await initDB();
await workerReady();
await verifyTrustedClockSync();
await detectPrinter();
await detectScanner();
await startHotspot();

markStartupReady();
```

you want something closer to:

```ts
await startHttpServer();

void initializePrintBit();
```

Then inside the initializer, run independent services concurrently:

```ts
async function initializePrintBit() {
  await initializeCriticalCore();

  const backgroundTasks = [
    initializePrinter(),
    initializeScanner(),
    initializeEsp32(),
    initializeTrustedTime(),
    initializeWatchdog(),
  ];

  await Promise.allSettled(backgroundTasks);

  evaluateOperationalReadiness();
}
```

And even better, don't wait for the whole `Promise.allSettled()` before evaluating readiness. Each component should update its status individually:

```ts
void initializePrinter()
  .then(() => startupState.printer = 'ready')
  .catch(() => startupState.printer = 'failed');

void initializeScanner()
  .then(() => startupState.scanner = 'ready')
  .catch(() => startupState.scanner = 'degraded');

void initializeEsp32()
  .then(() => startupState.esp32 = 'ready')
  .catch(() => startupState.esp32 = 'failed');
```

Then continuously calculate:

```ts
startupState.ready =
  startupState.database === 'ready' &&
  startupState.worker === 'ready' &&
  startupState.printer === 'ready' &&
  startupState.esp32 === 'ready';
```

That is much more robust.

### It also solves your ESP32-vs-router issue

With this structure:

```text
Router connected
NTP = 50 ms
mDNS = working

ESP32 connected
NTP = 3000 ms timeout
mDNS = unreliable
```

both environments still behave like:

```text
0.0 s   Node launches
0.1 s   port 3000 listening
0.2 s   /loading visible
0.3 s   initialization underway
...
```

Instead of:

```text
ESP32:
Node → NTP timeout → ESP32 registration → other startup → loading finally useful
```

The network differences no longer affect perceived kiosk startup.

### One further improvement

I would actually keep `/loading` at:

```text
http://127.0.0.1:3000/loading
```

permanently for Assigned Access.

Do not make the kiosk browser dependent on:

```text
192.168.4.2
printbit.local
ESP32 Wi-Fi
router Wi-Fi
```

at all.

The browser-to-server path stays:

```text
Edge
 ↓
127.0.0.1
 ↓
Node
```

Then Node independently communicates outward:

```text
                 ┌── C# Worker
                 │
127.0.0.1 Node ──┼── ESP32
                 │
                 ├── Printer
                 │
                 ├── Scanner
                 │
                 └── Network / mDNS
```

That isolation is exactly what you want for a kiosk.

So yes, I would deliberately redesign PrintBit startup around this rule:

> **Show `/loading` as soon as Express can accept localhost connections. Initialize hardware, networking, recovery, discovery, and auxiliary services behind it. Only leave `/loading` when the minimum transaction-critical subsystem set is operational.**

That would make your current loading page serve its intended purpose instead of having Windows/Node do most of the waiting before the user can meaningfully see it.
