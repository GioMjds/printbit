# Node Server Initialization Issue

For PrintBit, a **30-60 second startup is much more likely to be caused by initialization work around Node.js than by Node.js itself**.

A basic Express server can normally begin listening in well under a second. Your kiosk has several components that can introduce startup delays:

| Possible cause                             | Why it can take 30-60s                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ESP32/network initialization**           | The tablet may start before its Wi-Fi connection to the ESP32 is fully established. A connection attempt can wait for a timeout.                              |
| **Printer discovery/status checks**        | Windows Print Spooler, Epson services, WSD/USB discovery, or printer status queries can block while Windows finishes initializing the printer.                |
| **Scanner/NAPS2 initialization**           | Your previous NAPS2/TWAIN `OperationCanceledException` is a strong indicator that hardware probing can be slow or unreliable during startup.                  |
| **C# Worker connection**                   | If Node waits for the PrintBit Worker to start, establish IPC, or report printer/scanner readiness, that can delay the web app.                               |
| **Startup script ordering**                | Assigned Access may launch Chrome/Edge before Node, Caddy, the Worker, or network services are actually ready.                                                |
| **Blocking initialization in Node**        | Code such as `await printer.initialize()`, `await checkEsp32()`, `await scanner.listDevices()`, etc. before `app.listen()` can make the server appear "slow". |
| **Windows Defender / executable scanning** | On a Windows 10 kiosk, launching Node, Caddy, SumatraPDF, or Worker executables can occasionally incur startup overhead.                                      |
| **Filesystem/database initialization**     | Recursive file scanning, large directory operations, SQLite setup, or synchronous filesystem calls can block the Node event loop.                             |
| **Network timeout**                        | A very common cause. One failed connection with a `10s`, `15s`, or `30s` timeout can make startup look exactly like this.                                     |

### The most important architectural issue

I would check whether your PrintBit server currently does something conceptually like this:

```ts
await initializePrinter();
await initializeScanner();
await connectToWorker();
await checkEsp32();
await initializeStorage();

app.listen(PORT, () => {
  console.log(`PrintBit running on ${PORT}`);
});
```

That architecture means:

> **The kiosk has no web server until every dependency is ready.**

So if the printer takes 15 seconds and the network takes another 20 seconds, the customer sees nothing for 35 seconds.

For a kiosk, I would instead make the HTTP server start immediately:

```ts
app.listen(PORT, () => {
  console.log(`PrintBit server listening on ${PORT}`);
});

// Non-critical initialization happens after the server is available.
void initializePrinter();
void initializeScanner();
void connectToWorker();
void checkEsp32();
```

Then the UI can show something like:

```text
PrintBit
Starting kiosk services...

Printer:     Initializing...
Scanner:     Initializing...
Controller:  Connecting...
```

The server itself becomes available almost immediately, while the hardware services initialize in the background.

### This is especially important with Assigned Access

Your startup sequence should ideally be:

```text
Windows boots
    ↓
Network becomes available
    ↓
ESP32 connection established
    ↓
C# Worker starts
    ↓
Node.js server starts listening
    ↓
Browser/Assigned Access opens PrintBit
    ↓
PrintBit UI loads immediately
    ↓
Hardware initialization continues in background
```

But if your current sequence is closer to:

```text
Windows boots
    ↓
Assigned Access opens browser
    ↓
Browser requests localhost
    ↓
Node isn't ready yet
    ↓
Node starts
    ↓
Node waits for Worker
    ↓
Node waits for printer
    ↓
Node checks ESP32
    ↓
Node probes scanner
    ↓
Finally listen()
```

the browser can sit there waiting for 30-60 seconds.

### I would specifically investigate these three things first

**1. Anything before `app.listen()`**

Search your Node code for:

```ts
await
execSync(...)
spawnSync(...)
fs.readFileSync(...)
fs.readdirSync(...)
```

especially before the HTTP server starts.

Also inspect your `main.ts`, `server.ts`, `index.ts`, startup bootstrap, and dependency initialization.

**2. Network requests during startup**

Look for:

```ts
fetch(...)
axios.get(...)
axios.post(...)
```

especially requests to:

```text
192.168.4.1
192.168.4.2
localhost
127.0.0.1
```

A single failed ESP32 request can produce a large startup delay if you wait for its timeout.

For startup health checks, I would use a short timeout, for example:

```ts
const controller = new AbortController();

const timeout = setTimeout(() => controller.abort(), 2000);

try {
  await fetch("http://192.168.4.2:3000/health", {
    signal: controller.signal,
  });
} catch {
  console.log("ESP32 not ready yet");
} finally {
  clearTimeout(timeout);
}
```

Then retry in the background instead of blocking kiosk startup.

**3. Printer/scanner initialization**

Given the problems you've already seen with the Epson L5290, Windows Spooler, and NAPS2/TWAIN, I would be particularly suspicious of hardware probing.

For example, this is dangerous for startup:

```ts
const devices = await scannerService.listDevices();
```

when `listDevices()` ultimately performs a real TWAIN/device enumeration.

Likewise:

```ts
await printerService.getStatus();
```

can be problematic if it reaches into Windows printing infrastructure while the spooler/printer is still coming online.

The kiosk should **not require the printer to be completely initialized before serving the webpage**.

### Add startup timing logs

This will tell you exactly where the 30-60 seconds are going.

```ts
const startup = performance.now();

function mark(label: string) {
  console.log(
    `[STARTUP +${Math.round(performance.now() - startup)}ms] ${label}`,
  );
}

mark("Process started");

mark("Starting HTTP server");

const server = app.listen(PORT, () => {
  mark(`HTTP server listening on ${PORT}`);
});

mark("Starting background initialization");

void initializeWorker().then(() => mark("Worker ready"));
void initializePrinter().then(() => mark("Printer initialization complete"));
void initializeScanner().then(() => mark("Scanner initialization complete"));
void initializeEsp32().then(() => mark("ESP32 initialization complete"));
```

Then your log might reveal:

```text
[STARTUP +0ms] Process started
[STARTUP +25ms] Starting HTTP server
[STARTUP +48ms] HTTP server listening on 3000
[STARTUP +49ms] Starting background initialization
[STARTUP +120ms] Worker ready
[STARTUP +18200ms] Printer initialization complete
[STARTUP +31500ms] ESP32 initialization complete
[STARTUP +47200ms] Scanner initialization complete
```

That immediately proves:

> Node was ready in 48 ms.
> The 47-second delay was hardware/network initialization.

That distinction is important because otherwise it is easy to incorrectly conclude that **"Node.js is slow."**

### I would also change the kiosk readiness model

Instead of having one global state:

```text
READY / NOT READY
```

use independent service states:

```text
Web Server       READY
ESP32            CONNECTING
Printer          READY
Scanner          INITIALIZING
Worker           READY
```

The homepage can then decide what operations are actually available.

For example:

```text
Upload      Available
Copy        Disabled - Printer initializing
Scan        Disabled - Scanner initializing
```

That fits PrintBit much better than blocking the entire kiosk.

### One more thing to check

If the **browser itself takes 30-60 seconds to appear**, rather than appearing quickly and showing a loading/error page, then the problem may be **Assigned Access/Windows startup**, not Node.

In that case, measure these separately:

```text
Windows boot
   ↓
Assigned Access launches
   ↓
Node process starts
   ↓
Node begins listening
   ↓
Browser requests localhost
   ↓
Page finishes loading
```

These are five different timings.

For PrintBit, I would aim for roughly:

```text
Node process starts       < 1 sec
HTTP server listening     < 1 sec
localhost page responds   < 1-2 sec
Hardware initialization   background
```

The **30-60 second part should never be on the critical path of loading the customer UI**.

Given your specific PrintBit setup, my first investigation would be **the code that runs before `app.listen()` plus any startup request to the ESP32, C# Worker, Epson printer, or scanner**. Those are much more plausible causes than Express/Node startup itself.
