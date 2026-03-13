# PrintBit Installation & Dependencies Guide

This guide explains what software to install, what dependencies are used, and how to validate a working local setup.

## 1) Platform requirements

- **Primary target OS:** Windows 10/11 (kiosk deployment target).
- **Development OS:** Windows recommended; Linux/macOS can be used for API/frontend development but hardware integrations are Windows-centric.

## 2) Required software

## Core runtime

- **Node.js:** 20.x LTS (recommended baseline).
- **pnpm:** `10.13.1` (as declared by `packageManager` in `package.json`).
- **Git:** latest stable.

## Kiosk/production integrations

- **SumatraPDF portable executable** at: `bin/SumatraPDF.exe` (used for print dispatch).
- **MyPublicWiFi** (used for hotspot/captive behavior integration).
- **Printer driver package** for the production printer model.
- **Scanner driver package / TWAIN/WIA support** for the scanner model.
- **Serial/USB drivers** for coin acceptor and hopper controller (Arduino or equivalent).

## 3) Node package dependencies used by this project

## App dependencies (runtime)

- **Server/framework:** `express`, `socket.io`, `cookie-parser`.
- **Data/storage:** `lowdb`.
- **File handling:** `multer`, `file-type`, `xlsx`.
- **Document/media:** `pdfjs`, `pdfjs-dist`, `canvas`, `sharp`, `qrcode`.
- **Security/hash:** `argon2`.
- **Hardware/serial:** `serialport`, `@serialport/parser-readline`.
- **Malware scanning integration:** `clamscan`, `clamdjs`.

## Development dependencies

- TypeScript toolchain: `typescript`, `ts-node-dev`, `tsconfig-paths`.
- Type definitions: `@types/*` packages.
- Bundling: `esbuild`.

See full exact versions in [`package.json`](./package.json).

## 4) Installation steps

1\. Clone repository.
2\. Install dependencies:

```bash
pnpm install
```

3\. Start development server:

```bash
pnpm run dev
```

4\. Build client bundle:

```bash
pnpm run build
```

5\. Type-check:

```bash
pnpm exec tsc --noEmit
```

## 5) Preflight checklist (recommended)

- `bin/SumatraPDF.exe` exists.
- Printer appears online in Windows.
- Scanner is recognized by Windows/scanner APIs.
- Serial coin/hopper controller is connected and readable.
- `uploads/` directory is writable.
- `db.json` exists (or can be created by app init).
- Admin PIN and pricing configured through admin settings.

## 6) Common installation issues

- **Native dependency build failures** (`canvas`, `sharp`, `argon2`, `serialport`):
  - Ensure supported Node version is installed.
  - Reinstall dependencies after Node changes: `pnpm install`.
- **Printing fails:**
  - Verify `bin/SumatraPDF.exe` path and printer driver availability.
- **Scanner endpoints fail:**
  - Confirm scanner drivers and device permissions.
- **Hotspot features unavailable:**
  - Verify MyPublicWiFi installation and local permissions.

## 7) Related docs

- [README.md](./README.md)
- [OPERATIONS.md](./OPERATIONS.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [API_DOCUMENTATION.md](./API_DOCUMENTATION.md)
- [DOCUMENTATION_SUGGESTIONS.md](./DOCUMENTATION_SUGGESTIONS.md)
