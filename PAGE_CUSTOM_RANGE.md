# Custom Ranges UI/UX Enhancement

For PrintBit, I would make **custom page ranges a first-class part of the print-job model**, rather than treating it as a string that only the frontend understands.

The ideal flow is:

**Customer UI → validated page ranges → Node.js print-job contract → C# Worker → SumatraPDF/Windows spooler**

Your example:

> 30-page document → `1-5, 7-9, 15, 22-25`

should remain structured all the way through the system.

### 1. Customer UI/UX

I would avoid making customers type a complicated range string immediately.

Use a **Custom Pages** mode with individual range rows:

```text
┌──────────────────────────────────────┐
│ Pages                                │
│                                      │
│ ○ All pages                          │
│ ● Custom pages                       │
│                                      │
│ Print pages                          │
│                                      │
│ ┌──────────┐  -  ┌──────────┐        │
│ │    1     │     │    5     │  🗑    │
│ └──────────┘     └──────────┘        │
│                                      │
│ ┌──────────┐  -  ┌──────────┐        │
│ │    7     │     │    9     │  🗑    │
│ └──────────┘     └──────────┘        │
│                                      │
│        + Add page range              │
│                                      │
│ Pages selected: 8 / 30               │
│ Estimated sheets: 8                  │
│                                      │
│ [ Continue ]                         │
└──────────────────────────────────────┘
```

For a single page, allow the end field to be empty or provide a separate "single page" option:

```text
1 - 5
7 - 9
15
22 - 25
```

This is much easier for a kiosk touchscreen than expecting users to correctly type:

```text
1-5,7-9,15,22-25
```

You can still support the compact syntax as an **advanced/manual input** later.

---

## 2. Give the customer immediate feedback

This is particularly important for a kiosk.

Suppose the document has 30 pages and they select:

```text
1-5
7-9
15
22-25
```

Show:

```text
Selected pages

1  2  3  4  5   7  8  9   15   22 23 24 25

14 pages
```

And underneath:

```text
Document: 30 pages
Selected: 14 pages
Copies: 1
```

This gives the customer a chance to notice a mistake before inserting money.

### Validation should happen immediately

Examples:

```text
0-5       ❌ Page must start at 1
1-35      ❌ Document only has 30 pages
8-4       ❌ End page must be >= start page
1-5,5-9   ⚠️ Overlapping ranges
1-5,7-9   ✓ 8 pages selected
```

I would **automatically merge overlapping/adjacent ranges** internally:

```text
1-5, 4-9
```

becomes:

```text
1-9
```

and:

```text
1-5, 6-9
```

can become:

```text
1-9
```

This prevents accidental duplicate printing.

---

# 3. The important part: don't send the raw UI string to C#

Instead, define a print-job contract.

For example:

```ts
type PageRange = {
  start: number;
  end: number;
};

type PrintJob = {
  jobId: string;
  documentId: string;
  pageCount: number;

  pageSelection: {
    mode: 'all' | 'custom';
    ranges: PageRange[];
  };

  copies: number;

  paper: {
    size: 'A4' | 'LETTER' | 'LEGAL';
    orientation: 'portrait' | 'landscape';
  };

  colorMode: 'color' | 'grayscale';

  scaling: 'shrink' | 'fit' | 'actual';

  duplex: boolean;
};
```

For your example:

```json
{
  "jobId": "PB-20260926-001",
  "documentId": "doc_123",
  "pageCount": 30,
  "pageSelection": {
    "mode": "custom",
    "ranges": [
      { "start": 1, "end": 5 },
      { "start": 7, "end": 9 },
      { "start": 15, "end": 15 },
      { "start": 22, "end": 25 }
    ]
  },
  "copies": 1,
  "paper": {
    "size": "A4",
    "orientation": "portrait"
  },
  "colorMode": "grayscale",
  "scaling": "shrink",
  "duplex": false
}
```

This is much safer than:

```json
{
  "pages": "1-5,7-9,15,22-25"
}
```

The string can still exist at the UI boundary, but your internal model should be structured.

---

# 4. Node.js should own validation

Your Node.js application should be responsible for turning the customer's input into a **canonical print job**.

Something like:

```ts
function normalizeRanges(ranges: PageRange[], pageCount: number): PageRange[] {
  const normalized = ranges
    .map(({ start, end }) => ({
      start: Math.min(start, end),
      end: Math.max(start, end),
    }))
    .filter(({ start, end }) => start >= 1 && end <= pageCount)
    .sort((a, b) => a.start - b.start);

  const merged: PageRange[] = [];

  for (const range of normalized) {
    const previous = merged.at(-1);

    if (!previous || range.start > previous.end + 1) {
      merged.push({ ...range });
      continue;
    }

    previous.end = Math.max(previous.end, range.end);
  }

  return merged;
}
```

So:

```text
1-5
7-9
4-8
15
22-25
```

becomes:

```text
1-9
15
22-25
```

Then calculate:

```ts
function countPages(ranges: PageRange[]) {
  return ranges.reduce(
    (total, range) => total + (range.end - range.start + 1),
    0,
  );
}
```

Result:

```text
1-9       = 9
15        = 1
22-25     = 4

Total     = 14 pages
```

That number should be what your **pricing engine** uses, rather than the document's total page count.

This also connects nicely with your current PrintBit pricing problem. A 30-page document where the customer prints only pages `1-5, 7-9` should be treated as **8 printable pages**, not 30.

---

# 5. C# Worker should receive the canonical model

Create equivalent DTOs:

```csharp
public sealed record PageRange(
    int Start,
    int End
);

public sealed record PageSelection(
    string Mode,
    IReadOnlyList<PageRange> Ranges
);

public sealed record PrintJob(
    string JobId,
    string DocumentId,
    int PageCount,
    PageSelection PageSelection,
    int Copies,
    string PaperSize,
    string Orientation,
    string ColorMode,
    string Scaling,
    bool Duplex
);
```

Then your Worker doesn't need to know anything about:

```text
<input>
<button>
React
Next.js
Tailwind
```

It only knows:

```text
PrintJob
    ↓
PageSelection
    ↓
PrintPlan
    ↓
Printer
```

That separation is important.

---

# 6. Introduce a `PrintPlan`

I would actually add another abstraction in your C# Worker.

```csharp
public sealed record PrintPage(
    int PageNumber
);

public sealed record PrintPlan(
    IReadOnlyList<PrintPage> Pages,
    int TotalPages,
    int Copies
);
```

For:

```text
1-5, 7-9
```

the Worker turns it into:

```text
1
2
3
4
5
7
8
9
```

Then:

```text
PrintJob
   ↓
PageRangeValidator
   ↓
PrintPlanBuilder
   ↓
PrinterAdapter
```

This makes the architecture much easier to test.

---

# 7. You already have a major advantage with SumatraPDF

Since PrintBit already uses SumatraPDF, you don't necessarily need to implement page-range rendering yourself.

Current SumatraPDF supports page ranges through `-print-settings`, including comma-separated ranges. For example, its documentation gives syntax such as `1-3,5,10-8`. ([Sumatra PDF Reader][1])

So your Worker could eventually construct:

```text
1-5,7-9,15,22-25
```

and execute something conceptually like:

```text
SumatraPDF.exe
    -print-to "Epson L5290 Series"
    -print-settings "1-5,7-9,15,22-25,fit"
    document.pdf
```

SumatraPDF also provides exit codes for command-line printing, although an exit code cannot tell you about problems that happen after the job has been handed to the Windows spooler, such as paper-out or a printer jam. ([GitHub][2])

That distinction is particularly relevant to your existing PrintBit Worker.

---

# 8. Don't let SumatraPDF be your validation layer

I would **not** simply do:

```csharp
var range = job.PageSelection.Ranges;

var sumatraArguments =
    $"-print-settings \"{range}\"";
```

Instead:

```text
Node.js
    │
    │ validated PrintJob
    ▼
C# Worker
    │
    ├── ValidatePrintJob()
    │
    ├── NormalizeRanges()
    │
    ├── CalculatePrintablePages()
    │
    ├── CalculateCopies()
    │
    └── BuildPrintCommand()
            │
            ▼
       SumatraPDF
            │
            ▼
       Windows Spooler
            │
            ▼
       Epson L5290
```

You want the Worker to **trust the contract, but not blindly trust it**.

---

# 9. UX flow I recommend for PrintBit

I would structure the customer flow like this:

### Step 1 - Upload

```text
┌────────────────────────────┐
│ Document.pdf               │
│ 30 pages                   │
│                            │
│ [ Preview ]                │
└────────────────────────────┘
```

### Step 2 - Pages

```text
Print pages

● All pages
○ Custom pages

30 pages available
```

Customer chooses Custom:

```text
Print specific pages

┌───────┐   ┌───────┐
│  1    │ - │  5    │
└───────┘   └───────┘

┌───────┐   ┌───────┐
│  7    │ - │  9    │
└───────┘   └───────┘

+ Add another range

Selected: 8 pages
```

### Step 3 - Print settings

```text
Paper
A4

Color
Grayscale

Copies
[-] 1 [+]

Pages
8

Estimated cost
₱16.00

[ Continue ]
```

### Step 4 - Confirmation

This is where your existing coin-acceptor architecture becomes relevant.

```text
┌─────────────────────────────┐
│        PRINT SUMMARY        │
│                             │
│ Document       document.pdf │
│ Pages          1-5, 7-9     │
│ Total pages    8            │
│ Copies         1            │
│ Paper          A4           │
│ Color          Grayscale    │
│                             │
│ TOTAL          ₱16.00       │
│                             │
│ [ Cancel ]  [ Confirm ]     │
└─────────────────────────────┘
```

Only after **Confirm** should your existing `/confirm` process activate the coin acceptor.

That gives you a clean separation:

```text
Upload
  ↓
Configure
  ↓
Review
  ↓
Confirm
  ↓
Accept payment
  ↓
Create print job
  ↓
Print
```

---

# 10. Consider a compact input as an alternative

For users who already understand page ranges, you could offer:

```text
Custom pages

┌─────────────────────────────────┐
│ 1-5, 7-9, 15, 22-25             │
└─────────────────────────────────┘

Example: 1-5, 7, 10-12
```

Then underneath:

```text
✓ 14 pages selected
```

This is much faster for experienced users.

For a touchscreen kiosk, however, I'd make the **range-row interface the default** and potentially add the text parser under:

```text
Advanced page selection
```

---

# 11. Preview is worth adding

If your document preview already knows the page count, you could make the page selector visual:

```text
Pages

┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐
│ 1  │ │ 2  │ │ 3  │ │ 4  │ │ 5  │
│ ✓  │ │ ✓  │ │ ✓  │ │ ✓  │ │ ✓  │
└────┘ └────┘ └────┘ └────┘ └────┘

┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐
│ 6  │ │ 7  │ │ 8  │ │ 9  │ │ 10 │
│    │ │ ✓  │ │ ✓  │ │ ✓  │ │    │
└────┘ └────┘ └────┘ └────┘ └────┘
```

But I would **not render 30+ full page previews at once** on your kiosk. It could become expensive and cluttered.

For your use case, the range editor plus a small page summary is probably the better primary UX.

---

# 12. One important pricing consideration

You should distinguish:

```text
Document pages
```

from:

```text
Printable pages
```

For example:

```text
30-page document

Customer selection:
1-5, 7-9

Printable pages:
8

Copies:
2

Total printed pages:
16
```

Your pricing engine should therefore operate approximately on:

```ts
totalBillablePages = selectedPageCount * copies;
```

Then your other pricing dimensions can apply:

```text
billable pages
× color/grayscale
× paper size
× content classification
+ additional services
```

This is much more robust than using the uploaded file extension as a proxy for price.

---

## Recommended PrintBit architecture

I'd ultimately structure it like this:

```text
                    CUSTOMER UI
                         │
                         ▼
                Page Range Editor
                         │
                         ▼
                 Range Normalizer
                         │
                         ▼
                   PrintJob DTO
                         │
                         ▼
                 ┌───────────────┐
                 │ Node.js       │
                 │               │
                 │ Validation    │
                 │ Pricing       │
                 │ Job creation  │
                 └───────┬───────┘
                         │
                    local API / IPC
                         │
                         ▼
                 ┌───────────────┐
                 │ C# Worker     │
                 │               │
                 │ DTO validation│
                 │ PrintPlan     │
                 │ Printer state │
                 │ Progress      │
                 └───────┬───────┘
                         │
                         ▼
                    SumatraPDF
                         │
                         ▼
                  Windows Spooler
                         │
                         ▼
                    Epson L5290
```

The key design decision is **structured page ranges as the domain model**. The string `"1-5,7-9"` should only be a serialization format when you need to communicate with SumatraPDF, not the fundamental representation of the PrintBit print job.

That also gives you a clean foundation for later features such as **odd/even pages, reverse order, duplex printing, copies, collating, and page-specific pricing** without redesigning the entire print pipeline.

[1]: https://www.sumatrapdfreader.org/docs/Command-line-arguments?utm_source=chatgpt.com 'Command line arguments'
[2]: https://github.com/sumatrapdfreader/sumatrapdf/blob/master/docs/md/Printing.md?utm_source=chatgpt.com 'sumatrapdf/docs/md/Printing.md at master · sumatrapdfreader/sumatrapdf · GitHub'
