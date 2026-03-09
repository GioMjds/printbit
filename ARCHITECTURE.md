# PrintBit Architecture

## Overview

PrintBit is a kiosk-oriented Express application with static frontends and hardware/service integrations.
The backend serves pages, exposes APIs, and coordinates print/copy/scan/payment state.

## Runtime layers

## 1) HTTP + realtime layer

- Entry point: `src/server.ts`
- Express handles API/page routes.
- Socket.IO broadcasts live machine events:
  - balance updates,
  - coin accepted events,
  - upload status notifications,
  - serial status.

## 2) Route layer (`src/routes`)

- `financial-routes.ts`: balance, pricing, payment confirm, legacy upload/print.
- `wireless-session-routes.ts`: mobile upload session lifecycle and previews.
- `upload-portal-routes.ts`: tokenized upload page rendering and asset serving.
- `copy-routes.ts`: copy job lifecycle.
- `scan-routes.ts`: scan and preview job lifecycle.
- `admin-routes.ts`: protected settings, status, logs, and maintenance endpoints.
- `page-routes.ts`: HTML page routing.

## 3) Service layer (`src/services`)

- `db.ts`: LowDB persistence (`db.json`) for balance, earnings, settings, stats, logs.
- `serial.ts`: coin input parsing, balance mutation, and hopper command transport (shared 9600-baud serial line).
- `hopper.ts`: coin hopper orchestration — dispense with retries, stats tracking, owed-change fallback.
- `hopper-protocol.ts`: Arduino hopper serial protocol contract (command builders, response parser, error codes).
- `settlement.ts`: shared payment settlement logic (charge balance + dispense change) used by print and copy flows.
- `printer.ts`: SumatraPDF-based print dispatch.
- `session.ts`: in-memory wireless upload session domain.
- `hotspot.ts`: MyPublicWiFi process/config integration.
- `scanner.ts`: scanner adapter integration.
- `preview.ts`: document preview conversion/HTML generation.
- `admin.ts`: pricing calculations, logging, stats, reporting helpers.
- `job-store.ts`: in-memory copy/scan job state machine.

## 4) Frontend layer (`src/public`)

Static page modules for:

- print upload/session page
- upload page
- print config page
- confirm page
- copy page
- scan page
- admin pages

Frontend pages use REST APIs + Socket.IO to reflect machine state in near real-time.

## Data model

Persistent (`db.json`):

- `balance`
- `earnings`
- `settings` (pricing, admin settings, timeout)
- `coinStats`
- `jobStats`
- `logs`

Ephemeral (process memory):

- upload sessions (`SessionStore`)
- copy/scan jobs (`jobStore`)
- runtime process flags (serial/hotspot state)

## Main operational flows

## A) Print flow (wireless upload)

1. Kiosk creates session and QR.
2. Phone opens upload portal and uploads file.
3. Kiosk polls/receives upload completion.
4. User selects print settings.
5. Confirm endpoint validates funds and dispatches print.
6. Settlement: balance zeroed, earnings updated, change dispensed via coin hopper.
7. Socket.IO emits balance update and change dispense status events.

## B) Copy flow

1. Kiosk scans preview.
2. User confirms copy settings.
3. Copy job endpoint validates preview + funds.
4. Print dispatch runs asynchronously via job state updates.
5. Settlement: same as print — balance zeroed, change dispensed via hopper.

## C) Change dispensing (coin hopper)

1. Settlement logic computes `changeAmount = previousBalance - requiredAmount`.
2. If `changeAmount > 0`, sends `HOPPER DISPENSE <requestId> <coinCount>` to Arduino via serial.
3. Arduino acknowledges with `HOPPER ACK`, sends `HOPPER PROGRESS` updates, then `HOPPER DONE` or `HOPPER ERR`.
4. Protocol defined in `hopper-protocol.ts`; request IDs are 4-char hex for Arduino memory efficiency.
5. Hopper only dispenses **1-peso coins** — all pricing enforced as whole-peso integers.
6. On dispense failure, owed change is recorded for admin resolution (`owedChanges` in db.json).
7. Retries happen only for retryable error codes (JAM, MOTOR_TIMEOUT, PARTIAL).

## D) Admin flow

1. Admin authenticates with PIN.
2. UI reads summary/status/settings/logs.
3. Maintenance actions can reset balance, clear storage, update settings, export logs, and resolve owed changes.

## External dependencies

- MyPublicWiFi (hotspot + captive behavior)
- SumatraPDF executable for print dispatch
- Serial device for coin input + coin hopper (shared 9600-baud line via Arduino Uno)
- Scanner hardware adapter

## Design considerations

- Prioritizes kiosk availability even when optional hardware is unavailable.
- Uses strict request validation in most job endpoints.
- Uses mixed legacy and newer routes; migration toward unified APIs is ongoing.
