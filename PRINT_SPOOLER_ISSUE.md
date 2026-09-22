# PrintBit Printer Spooler Issue Summary

## Environment

* PrintBit kiosk runs on a **Windows 10 tablet**.
* Epson **L5290** is connected to the tablet through USB.
* The USB cable **remains connected throughout operating hours**.
* The tablet connects to an **isolated ESP32 Wi-Fi network**, so Internet access may be unavailable.
* Epson Printer Connection Checker is **not reliable/useful when the kiosk has no Internet**.

## Observed Symptoms

1. Printing sometimes stops working.
2. **Manual Windows printing also fails**, not just PrintBit printing.
3. At times, the Epson printer is **not detected properly by Windows**, despite the USB remaining physically connected.
4. Restarting or troubleshooting the Print Spooler has been part of the investigation.
5. Epson Printer Connection Checker cannot be relied upon because the kiosk may be completely offline.

## Important Diagnostic Conclusion

The problem should **not automatically be attributed to PrintBit, Node.js, or the C# Worker**.

Your printing pipeline is:

```text
Epson L5290
    ↓ USB
Windows 10 USB / PnP
    ↓
Epson Driver / Port
    ↓
Windows Print Spooler
    ↓
Print Queue
    ↓
C# Worker
    ↓
PrintBit
```

Because **manual Windows printing can also fail**, the problem may occur below the PrintBit application layer.

## Most Relevant Failure Areas

### 1. Windows Print Spooler

```text
Spooler = Running
Printer = Installed
USB = Connected
        ↓
Printing = Broken
```

The spooler service can be running while the queue or print-processing path is stuck.

### 2. Epson Driver / Print Processor

```text
USB = Connected
        ↓
Epson driver = unhealthy
        ↓
Printing = fails
```

The physical connection can remain intact while the Windows driver becomes unusable.

### 3. Windows Printer Port / Device State

Windows may still display:

```text
Epson L5290
```

while the underlying communication path is no longer functioning correctly.

### 4. USB/PnP State

Even without physically unplugging the printer, Windows could potentially experience a device/driver communication problem.

This should only become the primary suspect if Windows logs or Device Manager show USB/device errors.

## Most Useful Isolation Test

When the failure occurs:

```text
PrintBit printing      ❌
Windows manual print   ❌
```

This points toward:

```text
Windows / Epson driver / spooler / printer communication
```

rather than immediately blaming PrintBit.

Compare that with:

```text
PrintBit printing      ❌
Windows manual print   ✅
```

That would shift the investigation toward:

```text
C# Worker
    ↓
PrintBit job handling
    ↓
Printer selection
    ↓
Spooler API interaction
```

## Recommended PrintBit Direction

Do **not** make this dependent on:

```text
PrintBit
   ↓
Internet
   ↓
Epson Printer Connection Checker
```

The kiosk should remain functional on:

```text
Internet = OFF
ESP32 Wi-Fi = ON
Epson USB = connected
```

Instead, the C# Worker should eventually perform **local printer-health diagnostics** and distinguish states such as:

```text
Healthy
SpoolerProblem
PrinterOffline
QueueStuck
DriverPortProblem
Unknown
```

## Key Question to Answer Next

When the printer fails, determine:

> **Does Windows still recognize the Epson L5290 correctly, and does a manual print job enter the Windows print queue?**

That single observation will help identify whether the failure is primarily in:

```text
USB/PnP
   ↓
Epson Driver/Port
   ↓
Print Spooler
   ↓
C# Worker / PrintBit
```

rather than treating every failure as a generic "printer spooler issue."
