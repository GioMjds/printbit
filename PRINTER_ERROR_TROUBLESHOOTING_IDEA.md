# PrintBit Printer Error Summary

For the Epson L5290, PrintBit should distinguish **printer hardware errors** from **Windows/USB/software errors**.

## Main Printer Errors

| Category             | Examples                                                                | Severity   |
| -------------------- | ----------------------------------------------------------------------- | ---------- |
| **Paper**            | Paper Out, Paper Jam, Paper Feed Error, Misfeed, Multiple Sheets        | 🔴 Serious |
| **Ink**              | Ink Low, Ink Out, Ink System Error                                      | 🟡-🔴      |
| **Cover / Physical** | Cover Open, ADF Cover Open, Scanner Unit Open                           | 🔴 Serious |
| **Hardware**         | General Printer Error, Mechanism Error, Carriage Error, Printhead Error | 🔴 Serious |
| **Scanner / Copy**   | ADF Jam, Scanner Error, TWAIN/WIA Error, Scan Timeout                   | 🔴 Serious |
| **Communication**    | Printer Offline, USB disconnected, Driver Error                         | 🔴 Serious |
| **Windows Printing** | Print Spooler stopped, stuck queue, print processor/driver failure      | 🔴 Serious |
| **Power**            | Printer powered off, restart, power interruption                        | 🔴 Serious |

## Recommended PrintBit States

Instead of exposing Epson-specific messages directly to Node.js, the **C# Worker should normalize them** into application-level states:

```text
READY
PRINTING

PAPER_OUT
PAPER_JAM
PAPER_FEED_ERROR

COVER_OPEN

INK_WARNING
INK_ERROR

HARDWARE_ERROR
SCANNER_ERROR

PRINTER_OFFLINE
USB_ERROR
DRIVER_ERROR
SPOOLER_ERROR

UNKNOWN_ERROR
```

### Recovery principle

```text
Physical printer error
        ↓
Staff resolves physical problem
        ↓
Printer returns READY
        ↓
Worker verifies READY
        ↓
Transaction recovery
```

```text
Communication/software error
        ↓
Software recovery
        ↓
If unsuccessful
        ↓
Staff intervention
        ↓
USB reconnect as fallback
```

**USB replugging should therefore be an operator recovery procedure, not the universal solution for Epson errors.**

For `/confirm`, **Paper Jam, Paper Out, Cover Open, Hardware Error, Ink Error, and Printer Offline should block printing and show a staff-assistance state.**
