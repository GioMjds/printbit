# PrintBit Pricing Configuration Fix a Must Have

Yes. The main issue with the current approach is that **file format is a property of the input, not the actual print job**.

A customer should pay based on what PrintBit is actually going to put on paper, regardless of whether the source was:

- `photo.jpg`
- `image.png`
- `document.docx`
- `presentation.pptx`
- `spreadsheet.xlsx`
- `document.pdf`

A JPG renamed or converted to DOCX should not suddenly become cheaper if the resulting printed page is effectively the same.

## 1. Think of PrintBit pricing as "print output metering"

Instead of:

```text
JPG = ₱X
PNG = ₱X
PDF = ₱X
DOCX = ₱X
```

use:

```text
Uploaded file
      ↓
Parse / convert
      ↓
Render into actual printable pages
      ↓
Analyze each rendered page
      ↓
Determine:
  - paper size
  - number of pages
  - color / grayscale
  - coverage
  - duplex
  - print quality
  - paper type
      ↓
Calculate quote
      ↓
Customer confirms
      ↓
PrintBit Worker prints exact job
```

This is much harder to abuse because **the source format disappears from the pricing equation**.

---

# 2. What should actually affect the price?

I would separate the pricing system into four major dimensions.

### A. Paper consumption

This is the most deterministic part.

```text
A4
A5
Letter
Legal
etc.
```

Each can have a paper base cost.

Example:

```text
A4 paper = ₱1.00
Legal paper = ₱1.50
A5 paper = ₱0.75
```

These are only example values. Your actual values should come from your paper cost.

---

### B. Print mode

At minimum:

```text
BLACK_WHITE
COLOR
```

Then potentially:

```text
DRAFT
STANDARD
HIGH
```

For example:

```text
A4 B&W Standard = paper + B&W print charge
A4 Color Standard = paper + color print charge
A4 Color High = paper + higher print charge
```

This is already much better than file-extension pricing.

---

# 3. The interesting part: page coverage

This is probably what you are looking for when you say:

> "document content regardless of file formats"

You generally **do not need to understand the semantic content** of the document.

You don't really need to know:

> "This is a paragraph."

> "This is a photograph."

> "This is a logo."

Instead, analyze the **rendered page**.

For example:

### Page A

A4 page containing:

```text
Name: Juan Dela Cruz
Address: Laguna
Contact: 09xxxxxxxxx
```

Mostly white.

Estimated ink coverage:

```text
LOW
```

### Page B

A4 page containing a full-page photograph.

Estimated ink coverage:

```text
HIGH
```

Both are technically:

```text
1 page
A4
color
```

but their expected ink consumption is very different.

That gives you a much more defensible pricing model.

---

# 4. Use coverage tiers instead of trying to calculate exact ink consumption

I would **not** initially attempt:

```text
"This page consumes exactly ₱1.73 worth of ink."
```

Printer ink consumption is affected by many things:

- printer driver
- print quality
- dithering
- color calibration
- media type
- ink formulation
- printer head behavior
- image characteristics

Instead, create coverage bands.

For example:

```text
Coverage 0-10%     LOW
Coverage 10-40%    MEDIUM
Coverage 40-70%    HIGH
Coverage 70-100%   VERY_HIGH
```

Then:

```text
B&W + LOW       → base B&W price
B&W + MEDIUM    → base B&W + small surcharge
B&W + HIGH      → higher surcharge

COLOR + LOW     → base color price
COLOR + MEDIUM  → higher price
COLOR + HIGH    → significantly higher price
COLOR + VERY_HIGH → highest tier
```

This is much easier to explain to customers and much easier to calibrate.

---

# 5. Pricing should happen per page, not per file

This is another important design decision.

Consider a 10-page PDF:

```text
Page 1  - Color photo
Page 2  - Color photo
Page 3  - Black text
Page 4  - Black text
...
Page 10 - Black text
```

Do not classify the entire document as:

```text
COLOR_DOCUMENT
```

Instead:

```text
Page 1 → Color / High Coverage
Page 2 → Color / High Coverage
Page 3 → B&W / Low Coverage
...
```

Then sum the individual page prices.

That lets you handle mixed documents properly.

---

# 6. Paper size also needs to be determined from the actual output

There is an important distinction here.

Do not simply ask:

```text
What was the uploaded file's page size?
```

Ask:

```text
What paper size will PrintBit actually print this page on?
```

For example:

```text
DOCX
    ↓
render
    ↓
A4 output
```

or:

```text
Image 4000 × 3000
    ↓
customer selects A4
    ↓
fit-to-page
    ↓
A4 output
```

The image's native resolution should not determine the price.

The **physical print configuration** should.

---

# 7. Your canonical object should be a Print Job

I would design something similar to:

```ts
type PrintJob = {
  jobId: string;
  fileHash: string;

  pages: PrintPage[];

  copies: number;

  duplex: boolean;

  printQuality: 'draft' | 'standard' | 'high';

  totalAmount: number;
};

type PrintPage = {
  pageNumber: number;

  paperSize: 'A4' | 'A5' | 'LETTER' | 'LEGAL';

  colorMode: 'bw' | 'color';

  coverage: number;
  coverageTier: 'low' | 'medium' | 'high' | 'very_high';

  orientation: 'portrait' | 'landscape';
};
```

Notice something important:

There is **no `fileType` in the pricing information**.

The file type might still exist in metadata:

```ts
sourceFormat: 'docx';
```

but pricing should not care.

---

# 8. A better pricing formula

I would separate **paper cost** from **printing cost**.

For example:

```text
Total
=
Service Fee
+
Paper Cost
+
Print Cost
+
Optional Features
```

Then:

```text
Paper Cost
=
number of physical sheets × paper price
```

and:

```text
Print Cost
=
sum of each printed side's print cost
```

For a single page:

```text
Page Price
=
Paper Cost
+
Base Print Cost
× Coverage Multiplier
```

For example:

```text
A4 paper              ₱1.00
B&W base print        ₱1.00
Color base print      ₱3.00

Low coverage          ×1.00
Medium coverage       ×1.15
High coverage         ×1.40
Very high coverage    ×1.70
```

Again, those numbers are illustrative.

---

# 9. Duplex needs special treatment

This is where separating paper and print cost becomes valuable.

Suppose:

```text
10-page A4 document
Duplex
```

You have:

```text
10 printed sides
5 physical sheets
```

So:

```text
Paper cost = 5 × A4 paper price
Print cost = 10 × page printing cost
```

That is more accurate than simply doing:

```text
10 × "A4 page price"
```

because you are actually consuming only five physical sheets.

---

# 10. Copies should be applied after analysis

Suppose:

```text
10-page document
2 copies
```

Analyze the document once:

```text
Page 1 → B&W / LOW
Page 2 → Color / HIGH
...
```

Then:

```text
documentPrice × 2
```

You shouldn't need to analyze the same document twice.

---

# 11. Your biggest anti-abuse mechanism

This solves the exact concern you raised:

> "They can just convert image files to document files."

Correct.

They can.

But it won't matter.

For example:

### Customer A

Uploads:

```text
photo.jpg
```

PrintBit renders:

```text
A4
Color
High coverage
1 page
```

Quote:

```text
₱X
```

### Customer B

Uploads:

```text
photo.docx
```

PrintBit renders:

```text
A4
Color
High coverage
1 page
```

Quote:

```text
₱X
```

They paid the same because the **output characteristics are the same**.

That is the property you want.

---

# 12. Even better: normalize everything to PDF

For PrintBit, I would strongly consider making PDF your **internal canonical representation**.

Something like:

```text
                    ┌─ PDF ────────────────┐
JPG ────────────────┤                       │
PNG ────────────────┤                       │
DOCX ───────────────┤                       │
PPTX ───────────────┤   Canonical PDF      │
XLSX ───────────────┤                       │
TXT ────────────────┤                       │
                    └───────────────────────┘
                              ↓
                       Render pages
                              ↓
                       Analyze pages
                              ↓
                          Price job
                              ↓
                           Print
```

That makes your pricing system largely independent of file format.

---

# 13. For PrintBit specifically, I would use this architecture

Considering your existing Node.js + C# Worker architecture:

```text
Customer Device
       │
       │ Upload
       ▼
┌───────────────────┐
│ PrintBit Node.js  │
│ Kiosk Server      │
└─────────┬─────────┘
          │
          ▼
   File Normalizer
          │
          ├── PDF → pass through
          ├── DOCX → PDF
          ├── XLSX → PDF
          ├── PPTX → PDF
          └── Image → PDF
          │
          ▼
     Page Renderer
          │
          ▼
    Page Analyzer
          │
          ├── paper size
          ├── color
          ├── coverage
          ├── orientation
          └── page count
          │
          ▼
      Pricing Engine
          │
          ▼
       Price Quote
          │
          ▼
      Customer UI
          │
       Confirm
          │
          ▼
       Print Job
          │
          ▼
┌───────────────────┐
│ PrintBit Worker   │
│ C#                │
└─────────┬─────────┘
          │
          ▼
       Epson L5290
```

The **Node.js side should be authoritative for the quote**.

The C# Worker should receive the already-defined print job rather than trying to independently decide how much the customer should pay.

---

# 14. The quote should be immutable

This is important for kiosk abuse.

Suppose the customer gets:

```text
Quote #PB-2026-00123

A4 Color
3 pages
Coverage: High
Total: ₱15.00
```

Then they press Confirm.

You should associate that quote with something like:

```ts
{
  quoteId: "...",
  fileHash: "sha256...",
  renderedDocumentHash: "...",
  pricingVersion: "v2",
  printOptionsHash: "...",
  expiresAt: "...",
  total: 15.00
}
```

Then `/confirm` verifies:

```text
Is quote valid?
Is it expired?
Is the file unchanged?
Are the print options unchanged?
Is the pricing version unchanged?
```

If something changes:

```text
Quote invalid
→ recalculate
```

This prevents situations where a customer gets a cheap quote and then changes the underlying file or layout.

---

# 15. Don't calculate price from upload metadata

I would explicitly avoid using these as your primary pricing mechanism:

```text
file extension
MIME type
file size
filename
image resolution
number of bytes
DOCX size
PDF size
number of embedded images
number of words
```

For example:

```text
10 MB JPG
```

doesn't necessarily mean more printing cost than:

```text
500 KB JPG
```

And:

```text
20 KB DOCX
```

could contain a full-page black image.

The rendered output is what matters.

---

# 16. What about "document content"?

There are two different meanings here.

### Semantic content

Things such as:

```text
number of words
number of paragraphs
number of images
text length
```

I would **not use this for pricing**.

It creates strange incentives and doesn't correspond cleanly to printer resource usage.

### Physical print content

Things such as:

```text
how much of the page is covered
whether it is monochrome or color
how dark the page is
how much color is present
```

This is useful.

So I'd define your feature as:

> **Print Coverage**

rather than:

> **Document Content**

That will also be easier to explain in your UI and documentation.

---

# 17. A good PrintBit pricing hierarchy

I would build it in stages.

### Version 1

Keep it deterministic:

```text
Paper Size
+
B&W / Color
+
Number of Pages
+
Copies
+
Duplex
```

This is probably enough for your first deployment.

### Version 2

Add:

```text
Coverage Tier
```

For example:

```text
LOW
MEDIUM
HIGH
VERY_HIGH
```

### Version 3

Add:

```text
Print Quality
Paper Type
```

and potentially different rates.

### Version 4

Calibration against actual Epson consumption:

```text
coverage → observed ink usage
```

Then tune your multipliers from real PrintBit print jobs.

I would **not start with exact ink-volume estimation**. It adds a lot of engineering complexity for relatively little benefit in a school kiosk.

---

# 18. Your pricing engine could eventually look like this

```ts
const pricingEngine = new PricingEngine({
  paper: {
    A4: 1.0,
    A5: 0.75,
    LETTER: 1.0,
    LEGAL: 1.5,
  },

  print: {
    bw: {
      base: 1.0,
      coverage: {
        low: 1.0,
        medium: 1.15,
        high: 1.4,
        very_high: 1.7,
      },
    },

    color: {
      base: 3.0,
      coverage: {
        low: 1.0,
        medium: 1.2,
        high: 1.5,
        very_high: 2.0,
      },
    },
  },

  serviceFee: 2.0,
});
```

Then:

```ts
const quote = pricingEngine.calculate(printJob);
```

The output could be:

```ts
{
  subtotal: 18.50,

  breakdown: [
    {
      page: 1,
      paper: "A4",
      mode: "color",
      coverage: "high",
      amount: 5.25
    },
    {
      page: 2,
      paper: "A4",
      mode: "bw",
      coverage: "low",
      amount: 2.00
    }
  ],

  total: 20.50
}
```

That gives you something you can display transparently to the customer.

---

# 19. The most important conceptual model

I'd make your PrintBit pricing system follow this rule:

```text
SOURCE FORMAT
     ↓
doesn't determine price
```

Instead:

```text
PRINT RESULT
    ↓
paper size
+ physical sheets
+ printed sides
+ color mode
+ coverage
+ quality
+ paper type
+ copies
    ↓
PRICE
```

That is the architectural change I'd make.

For **PrintBit specifically**, I think the strongest design is a **render-first pricing engine** where every supported file is converted into a canonical printable representation, each page is analyzed independently, and the quote is generated from the resulting `PrintJob` rather than from the uploaded file extension.

The next engineering problem worth solving is the **page-analysis algorithm itself**, especially how to estimate B&W/color coverage from PDF pages in your offline Windows kiosk without making the quote slow or inaccurate.
