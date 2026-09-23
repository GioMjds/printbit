# PrintBit Printing Setup, Final Recommended Approach

Yes. To combine the last two discussions into one implementation, I would make **PrintBit responsible for the customer's print configuration**, while the Epson L5290 preferences serve only as a safe baseline.

The target architecture should be:

```text
/config
   ↓
Node.js stores customer's settings
   ↓
/confirm
   ↓
Payment
   ↓
C# Worker receives exact print configuration
   ↓
SumatraPDF + Epson driver
   ↓
Epson L5290
   ↓
Physical paper
```

The key requirement is:

> **The `/config` preview, C# Worker, SumatraPDF and Epson driver must agree on the same target paper size and scaling rule.**

---

## 1. First decide what paper is physically inside the L5290

This is the most important deployment decision.

The L5290 does not have separate trays for:

```text
A4
Letter
Legal
```

If A4 is physically loaded but PrintBit tells the printer to use Legal, software cannot compensate for the physical paper difference.

For an unattended kiosk, I recommend:

```text
Physical paper loaded: A4
Printer default:       A4
PrintBit default:      A4
```

Then uploaded documents can still have other sizes:

```text
Letter document ─┐
Legal document  ──┼── Fit ──> A4 paper
A4 document     ──┘
```

This is the most reliable approach.

If your actual project requirement says customers must physically receive A4, Letter, and Legal, then staff will need to change the loaded paper when necessary, or you eventually need a printer with multiple paper trays.

---

# 2. Configure Epson L5290 Printing Preferences once

Go to:

```text
Settings
→ Printers & scanners
→ Epson L5290
→ Printing preferences
```

I recommend this baseline:

| Setting                | Recommended |
| ---------------------- | ----------- |
| Document Size          | A4          |
| Output Paper           | A4          |
| Paper Type             | Plain Paper |
| Orientation            | Portrait    |
| Quality                | Standard    |
| Color                  | Color       |
| Copies                 | 1           |
| Bidirectional Printing | Enabled     |
| Mirror Image           | Disabled    |
| Rotate 180°            | Disabled    |

## Reduce/Enlarge Document

This setting is the important one you discovered.

When enabled, Epson separates:

```text
Document Size
```

from:

```text
Output Paper
```

and allows:

```text
Fit to Page
```

That is why the result looked more correct during your manual testing.

For testing, configure:

```text
[x] Reduce/Enlarge Document

(o) Fit to Page

Document Size: A4
Output Paper:  A4
```

However, **PrintBit should not depend exclusively on this checkbox**.

It is fine to leave it configured as a safe Epson baseline, but C# should still explicitly request fitting for every job.

---

# 3. Add scaling to PrintBit's print configuration

Your `/config` route currently needs to represent more than paper size.

Conceptually:

```ts
export interface PrintConfiguration {
  paperSize: 'A4' | 'Letter' | 'Legal';
  orientation: 'portrait' | 'landscape';

  scaling: 'fit' | 'actual';

  colorMode: 'color' | 'grayscale';
  quality: 'standard' | 'high';

  copies: number;
}
```

For most customers:

```ts
scaling: 'fit';
```

should be the default.

You could expose it in the UI as:

```text
Scaling

● Fit to page        Recommended
○ Actual size
```

Or, for a kiosk, you could keep it completely automatic:

```text
scaling = fit
```

without giving customers another setting to understand.

For PrintBit, I prefer automatic **Fit to Page**.

---

# 4. Send the exact configuration from Node.js to C#

For example:

```json
{
  "transactionId": "PB-20260913-00123",
  "filePath": "C:\\PrintBit\\temp\\document.pdf",

  "paperSize": "A4",
  "orientation": "portrait",
  "scaling": "fit",

  "colorMode": "color",
  "quality": "standard",
  "copies": 1
}
```

Node.js should not directly manipulate the Windows printer.

The responsibilities should be:

```text
Node.js
├── /config
├── preview
├── pricing
├── transaction
├── payment
└── send PrintConfiguration

C# Worker
├── validate printer
├── construct print settings
├── execute SumatraPDF
├── monitor Windows queue
└── report job status
```

---

# 5. Translate those settings inside C#

Create a dedicated mapping service.

Something conceptually like:

```csharp
public string BuildPrintSettings(PrintConfiguration config)
{
    var settings = new List<string>();

    settings.Add(config.PaperSize switch
    {
        "A4" => "paper=A4",
        "Letter" => "paper=letter",
        "Legal" => "paper=legal",
        _ => "paper=A4"
    });

    settings.Add(config.Scaling switch
    {
        "fit" => "fit",
        "actual" => "noscale",
        _ => "fit"
    });

    settings.Add(config.Orientation switch
    {
        "landscape" => "landscape",
        _ => "portrait"
    });

    settings.Add("ignore-pdf-print-settings");

    return string.Join(",", settings);
}
```

Then:

```csharp
var printSettings = BuildPrintSettings(config);
```

may produce:

```text
paper=A4,fit,portrait,ignore-pdf-print-settings
```

or:

```text
paper=legal,fit,landscape,ignore-pdf-print-settings
```

---

# 6. Execute SumatraPDF from C#

Conceptually:

```csharp
var arguments =
    $"-print-to \"{printerName}\" " +
    $"-print-settings \"{printSettings}\" " +
    $"\"{pdfPath}\"";
```

For A4:

```text
SumatraPDF.exe
-print-to "EPSON L5290 Series"
-print-settings "paper=A4,fit,portrait,ignore-pdf-print-settings"
document.pdf
```

For Letter:

```text
paper=letter,fit,portrait,ignore-pdf-print-settings
```

For Legal:

```text
paper=legal,fit,portrait,ignore-pdf-print-settings
```

The critical combination is:

```text
paper=<TARGET>,fit
```

not merely:

```text
paper=<TARGET>
```

---

# 7. Make `/config` preview use the same rule

This is where many of your current discrepancies are probably coming from.

You currently have two conceptual renderers:

```text
Browser preview
```

and:

```text
Sumatra/Epson physical print
```

They should implement the same transformation.

Suppose the uploaded PDF is Letter:

```text
216 × 279 mm
```

and PrintBit's target is A4:

```text
210 × 297 mm
```

The preview should represent:

```text
Source: Letter

        ↓

Target: A4

        ↓

Preserve aspect ratio

        ↓

Scale until entire Letter page fits
inside A4 printable area
```

Then physical printing also uses:

```text
paper=A4,fit
```

That gives:

```text
                         SAME CONFIG

                         PrintConfig
                             │
                ┌────────────┴────────────┐
                │                         │
                ▼                         ▼

        Browser Preview              C# Worker

        Target = A4                  paper=A4
        Scaling = fit                fit
        Portrait                     portrait
        Margins                      printer margins

                │                         │
                └────────────┬────────────┘
                             │
                             ▼

                Preview ≈ Physical Output
```

That is the actual goal.

---

# 8. Do not use `stretch`

You want:

```text
FIT
```

rather than:

```text
STRETCH
```

Fit maintains aspect ratio.

For example:

```text
Source

┌───────────────┐
│               │
│   DOCUMENT    │
│               │
└───────────────┘


Fit to A4

┌─────────────────────┐
│   ┌─────────────┐   │
│   │             │   │
│   │  DOCUMENT   │   │
│   │             │   │
│   └─────────────┘   │
└─────────────────────┘
```

Stretch could distort the document:

```text
┌─────────┐       ┌────────────────┐
│ CONTENT │  -->  │    CONTENT     │
└─────────┘       └────────────────┘
```

For forms, IDs, academic documents and images, that would be undesirable.

---

# 9. Decide how PrintBit's A4/Letter/Legal option actually works

You currently have an architectural question to resolve.

## Option A, recommended for the kiosk

Make these mean **source conversion to A4**:

```text
Customer document

A4 ────────────────┐
Letter ────────────┼── Fit ──> Physical A4
Legal ─────────────┘
```

Then PrintBit doesn't really need a physical paper-size selector.

It could simply say:

```text
Paper

A4
```

while displaying:

```text
Your document will automatically
be fitted to A4 paper.
```

This is the most reliable unattended implementation.

---

## Option B, keep A4 / Letter / Legal

Then these must represent actual physical media:

```text
PrintBit A4
→ physical A4 must be loaded

PrintBit Letter
→ physical Letter must be loaded

PrintBit Legal
→ physical Legal must be loaded
```

You cannot have:

```text
PrintBit = Legal
Physical tray = A4
```

and expect correct Legal output.

If you're going to retain all three options, PrintBit should know the currently loaded paper.

For example:

```json
{
  "loadedPaper": "A4"
}
```

Then:

```text
User selects Legal

         ↓

PrintBit detects:
Loaded paper = A4

         ↓

BLOCK PRINTING

"Legal paper is currently unavailable."
```

That is much safer.

---

# 10. Add a physical-paper setting to the Admin side

I would actually implement this in PrintBit.

For example:

```text
Admin
→ Printer
→ Paper Configuration
```

with:

```text
Currently Loaded Paper

● A4
○ Letter
○ Legal
```

Store:

```ts
type LoadedPaper = 'A4' | 'Letter' | 'Legal';
```

Before payment:

```ts
if (selectedPaper !== loadedPaper) {
  blockTransaction();
}
```

This prevents customers from paying for an impossible configuration.

---

# 11. Validate everything before `/confirm`

The best workflow is:

```text
/upload
   ↓
Analyze document
   ↓
/config
   ↓
Select:
paper
orientation
quality
color
copies
   ↓
Generate preview using FIT
   ↓
Validate physical printer configuration
   ↓
Is requested paper available?
   │
   ├── NO
   │    ↓
   │  Block
   │
   └── YES
        ↓
     /confirm
        ↓
   Enable coin acceptor
        ↓
      Payment
        ↓
     C# Worker
        ↓
     Print
```

This also ties directly into your recent requirement that the coin acceptor should only become active at `/confirm`.

Printer validation should happen **before accepting coins**.

---

# 12. Add preflight validation in C#

Before PrintBit allows payment:

```text
C# Worker checks:

✓ Epson printer detected
✓ Printer online
✓ Windows Spooler running
✓ No critical printer error
✓ C# Worker healthy
✓ Requested physical paper available
✓ SumatraPDF available
✓ PDF exists
✓ Print configuration valid
```

Then C# reports:

```json
{
  "ready": true
}
```

Node can allow:

```text
/config
   ↓
/confirm
   ↓
Coin acceptor ON
```

If:

```json
{
  "ready": false,
  "reason": "PRINTER_OFFLINE"
}
```

PrintBit should never enable the acceptor.

---

# 13. Test this systematically before deployment

Don't test only one PDF.

Build a test matrix.

| Source PDF | Target Paper | Orientation | Scaling | Expected               |
| ---------- | ------------ | ----------- | ------- | ---------------------- |
| A4         | A4           | Portrait    | Fit     | No crop                |
| A4         | A4           | Landscape   | Fit     | Rotated correctly      |
| Letter     | A4           | Portrait    | Fit     | Slight scaling         |
| Legal      | A4           | Portrait    | Fit     | Reduced vertically     |
| Image      | A4           | Portrait    | Fit     | Aspect ratio preserved |
| A4         | Letter       | Portrait    | Fit     | Fits Letter            |
| Letter     | Letter       | Portrait    | Fit     | Near 1:1               |
| Legal      | Legal        | Portrait    | Fit     | Near 1:1               |

For every test compare:

```text
/config preview
vs
physical output
```

Look specifically at:

- margins
- top/bottom clipping
- left/right clipping
- text size
- image proportions
- orientation
- page centering
- headers
- footers
- page count

---

# Final PrintBit configuration I recommend

For your **current Epson L5290 kiosk**, I would implement:

```text
Physical printer
────────────────────────────────
Paper loaded:       A4
Printer default:    A4
Paper type:         Plain Paper
Orientation:        Portrait
Quality:            Standard
Color:              Color
Bidirectional:      Enabled
Reduce/Enlarge:     Fit to Page
```

Then PrintBit:

```text
Node.js
────────────────────────────────
Paper target:       A4
Scaling:            Fit
Orientation:        User selection
Color:              User selection
Quality:            User selection
Copies:             User selection
```

Then C#:

```text
C# Worker
────────────────────────────────
paper=A4
fit
portrait/landscape
ignore-pdf-print-settings
```

Result:

```text
                PRINTBIT PRINT PIPELINE

Uploaded PDF
     │
     │ Can be A4 / Letter / Legal / etc.
     ▼
PDF Analysis
     │
     ▼
/config
     │
     ├─ Target paper: A4
     ├─ Scaling: FIT
     ├─ Orientation
     ├─ Color
     ├─ Quality
     └─ Copies
     │
     ▼
Preview
     │
     │ SAME scaling algorithm
     ▼
Printer Preflight
     │
     ├── Printer ready? ─── No ──> Block
     ├── Paper available? ─ No ──> Block
     └── Worker ready? ──── No ──> Block
     │
     ▼
/confirm
     │
     ▼
Coin Acceptor ON
     │
     ▼
Payment Complete
     │
     ▼
C# Worker
     │
     ▼
SumatraPDF
paper=A4,fit,...
     │
     ▼
Epson Driver
     │
     ▼
Physical A4
```

## The critical change

The main correction is **not simply ticking Epson's "Reduce/Enlarge Document" checkbox**.

The real correction is making PrintBit explicitly understand:

```text
SOURCE DOCUMENT SIZE
        ↓
TARGET PHYSICAL PAPER
        ↓
SCALING MODE
        ↓
PRINTABLE AREA
```

and using those same values throughout:

```text
/config preview
        =
Node configuration
        =
C# configuration
        =
SumatraPDF configuration
        =
Epson output
```

For your current L5290 deployment, I would standardize on **physical A4 + Fit to Page**, make Epson's preferences a safe baseline, and let the **C# Worker explicitly control every individual print job**. That gives you the best chance of eliminating the current preview-versus-physical-output mismatch while keeping the kiosk predictable.
