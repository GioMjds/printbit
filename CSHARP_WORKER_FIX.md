# C# Worker and Epson L5290 printing issues

Based on the current PrintBit and PrintBit Worker code, I would classify this as **primarily a C# Worker tracking/verification problem**, triggered by a limitation in Windows/Epson spooler telemetry. Node.js is mostly displaying the state it receives from the Worker.

## What is happening

For your test:

```text
Document pages: 1
Copies:         5
Physical output expected: 5 sheets
```

Your current `DocumentPrinter.cs` calculates:

```csharp
expectedPages = pages.Count * settings.Copies
```

So:

```text
1 page × 5 copies = 5 expected
```

However, PrintBit sends those copies to SumatraPDF as **one native multi-copy print job**, effectively:

```text
SumatraPDF
    |
    | 1-page PDF, copies=5
    v
Windows Spooler
    |
    | ONE print job
    v
Epson Driver
    |
    +--> Copy 1
    +--> Copy 2
    +--> Copy 3
    +--> Copy 4
    +--> Copy 5
```

Your repository explicitly documents that all requested copies are submitted as one native multi-copy spooler job.

The problem is that the C# Worker then asks:

```text
Win32_PrintJob.PagesPrinted
Win32_PrintJob.TotalPages
```

to determine progress.

Microsoft documents `PagesPrinted` as a spooler-level value, and notes that these values may not always contain useful page delimiting information. ([Microsoft Learn][1]) More importantly, your own Worker documentation already warns that `PagesPrinted` is **best-effort**, may lag behind physical output, and that native multi-copy jobs can expose only document-page granularity until completion.

So the Epson can physically be doing:

```text
Physical printer:
██████████████████████████

Copy 1 ✅
Copy 2 ✅
Copy 3 ✅
Copy 4 printing...
Copy 5 queued internally...
```

while Windows still tells C#:

```text
PagesPrinted = 1
```

Then C# calculates:

```text
Worker expected = 5
Spooler reports = 1

UI:
1 / 5
```

That explains the first symptom almost exactly.

## Why does PrintBit say "Printing was stopped before completion"?

There is a second problem in the Worker.

Your spooler verification currently uses a **45-second progress grace period**. That timer gets refreshed when `PagesPrinted` increases or certain recovery events occur.

But consider your five-copy job:

```text
t=0s   PagesPrinted = 0
t=8s   PagesPrinted = 1
        Worker shows 1/5

t=16s  Epson prints copy 2
        Windows still says 1

t=25s  Epson prints copy 3
        Windows still says 1

t=35s  Epson prints copy 4
        Windows still says 1

t=45s+ Worker:
        "No progress occurred."

        -> SpoolerVerification failure

Meanwhile...

t=50s  Epson prints copy 5
```

The Worker can therefore conclude:

```text
FAILED
```

even though the physical printer is still happily processing the data already handed to it.

Your `DocumentPrinter` has a `SpoolerProgressGracePeriod = 45 seconds` and tracks `maxPagesPrinted` from `QueryJobStatus()`. The latter directly queries `Win32_PrintJob.PagesPrinted` and `TotalPages`.

There is another Windows-specific complication. Microsoft explicitly notes that some port monitors can mark a job `JOB_STATUS_PRINTED` **as soon as the job has been submitted to the printer**, rather than when the physical sheet actually finishes. ([Microsoft Learn][2])

In other words:

```text
C# / Windows concept of "finished"
           ≠
Epson physically finished printing
```

That distinction matters a lot for a kiosk.

## Node.js is probably not the source

Your Node frontend contains this generic recovery UI:

> `Printing Needs Staff Assistance`

with:

> `Printing was stopped before completion.`

It is rendered for Worker-side failures such as `WORKER_PRINT_FAILED`.

And the Node lifecycle code receives the Worker's failure stage and stores it as a print failure.

So the chain is likely:

```text
Epson
   |
   | printing normally
   v
Windows Spooler
   |
   | PagesPrinted = 1
   | despite copies being printed
   v
C# Worker
   |
   | expects 5
   | sees progress stuck at 1
   | verification eventually fails
   v
Node.js
   |
   | receives Worker failure
   v
Confirm UI

"Printing Needs Staff Assistance"
"Printing was stopped before completion."
```

Therefore I would assign responsibility roughly like this:

| Component            | Assessment                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| **C# Worker**        | **Main problem** - incorrect assumption that spooler `PagesPrinted` equals physical multi-copy progress |
| Windows/Epson driver | Contributing limitation - coarse/lagging spooler telemetry                                              |
| Epson L5290 hardware | Probably functioning correctly in this test                                                             |
| Node.js              | Mostly innocent - displaying the failure reported by Worker                                             |

---

## The fix I recommend for PrintBit

For a **payment kiosk**, I would stop using native `5x` printing if you require trustworthy `1/5`, `2/5`, `3/5`, etc. progress.

Instead, dispatch each copy as its own spooler job.

Current:

```text
SumatraPDF:
1-page.pdf
Copies = 5

        ↓

ONE spooler job

        ↓

Epson internally produces:
1
2
3
4
5
```

Change it to:

```text
Copy 1
SumatraPDF - 1x
        ↓
wait/verify
        ↓
1/5

Copy 2
SumatraPDF - 1x
        ↓
wait/verify
        ↓
2/5

Copy 3
        ↓
3/5

Copy 4
        ↓
4/5

Copy 5
        ↓
5/5
```

For example, with a three-page document and five copies:

```text
Copy 1:
pages 1,2,3
logical progress = 3/15

Copy 2:
pages 1,2,3
logical progress = 6/15

Copy 3:
pages 1,2,3
logical progress = 9/15

Copy 4:
pages 1,2,3
logical progress = 12/15

Copy 5:
pages 1,2,3
logical progress = 15/15
```

This has a major advantage for PrintBit: if the printer jams during copy 4, you actually know that copies 1-3 were dispatched successfully.

That information is extremely useful for **refund calculations**.

```text
Requested: 5 copies
Successful: 3
Failure: copy 4

Potential refund:
2 copies
```

With one native five-copy spooler job, determining that reliably is much harder.

## Also fix the 45-second rule

Regardless of whether you change copy dispatching, I would change this logic:

```text
PagesPrinted hasn't changed for 45 seconds
             ↓
          FAILURE
```

to something closer to:

```text
Is spooler job still present?
        |
        +-- YES
        |
        +-- Is status Printing/Spooling?
        |       |
        |       +-- YES
        |       |
        |       +-- Any fatal printer error?
        |               |
        |               +-- NO → continue waiting
        |
        +-- NO
             |
             +-- job was previously observed?
             +-- printer healthy?
             +-- post-clear guard
             |
             +-- complete
```

`PagesPrinted` should be **telemetry**, not the authoritative watchdog heartbeat.

Specifically, do not declare:

```csharp
SpoolerVerification FAILED
```

merely because:

```csharp
PagesPrinted == previousPagesPrinted
```

while the spooler job still exists and Windows reports it as actively printing.

---

## One very useful test right now

While doing the exact same **1-page × 5-copy** test, open an elevated PowerShell window and run this repeatedly:

```powershell
Get-CimInstance Win32_PrintJob |
    Select-Object Name,
                  Document,
                  JobStatus,
                  StatusMask,
                  PagesPrinted,
                  TotalPages
```

I strongly expect you'll see something resembling:

```text
PagesPrinted : 1
TotalPages   : 1
```

even while the Epson is physically producing copy 3, 4, or 5.

Then run a different test:

```text
5-page PDF
Copies = 1
```

If PrintBit progresses something like:

```text
1/5
2/5
3/5
4/5
5/5
```

while:

```text
1-page PDF
Copies = 5
```

stays:

```text
1/5
```

then you have essentially proven the issue is **native-copy spooler granularity**, not the L5290 failing to print.

### Recommended architecture

For PrintBit specifically, I would use:

```text
Node.js
    |
    | Print request
    | pages=1
    | copies=5
    v
C# JobOrchestrator
    |
    +---- Copy 1 -> Sumatra 1x -> verify
    |
    +---- Copy 2 -> Sumatra 1x -> verify
    |
    +---- Copy 3 -> Sumatra 1x -> verify
    |
    +---- Copy 4 -> Sumatra 1x -> verify
    |
    +---- Copy 5 -> Sumatra 1x -> verify
    |
    v
Aggregate result
    |
    +-- completedCopies
    +-- failedCopy
    +-- logicalPagesPrinted
    +-- totalExpectedPages
    v
Node.js UI
```

So I would **not troubleshoot the Epson L5290 hardware first** for this particular incident. The printer continuing through copies 3-5 is actually evidence that the physical print pipeline is working. The bug is that your C# Worker is treating unreliable Windows spooler page telemetry as authoritative physical progress, then the Node frontend correctly reacts to the false failure reported by the Worker.

[1]: https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-printjob?utm_source=chatgpt.com 'Win32_PrintJob class - Win32 apps | Microsoft Learn'
[2]: https://learn.microsoft.com/en-us/windows/win32/printdocs/job-info-1?utm_source=chatgpt.com 'JOB_INFO_1 structure (Winspool.h) - Win32 apps | Microsoft Learn'
