# Disclaimer

## PrintBit — Coin-Operated Self-Service Printing Kiosk

> **Read carefully before deploying, operating, or modifying PrintBit.**

---

## 1. Academic Project

PrintBit is a capstone project developed for academic purposes. It was
designed and tested within the context of a university campus environment.
It is **not** a commercially licensed or professionally audited product. The
authors provide no guarantees of fitness for any particular purpose beyond
the scope of the capstone submission.

---

## 2. No Warranty

THE SOFTWARE IS PROVIDED **"AS IS"**, WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.

The authors do not warrant that:

- The software will operate without interruption or error.
- Print jobs will complete successfully under all conditions.
- Coin transactions will be processed without loss or hardware fault.
- The ESP32 captive portal will function on all network configurations.

---

## 3. Limitation of Liability

IN NO EVENT SHALL THE AUTHORS, CONTRIBUTORS, OR THEIR AFFILIATED INSTITUTION
BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES INCLUDING BUT NOT LIMITED TO:

- Loss of coins or monetary value due to hardware or software failure.
- Loss or corruption of uploaded user documents.
- Printer malfunction, paper jams, or consumable damage.
- Data breaches resulting from misconfigured deployment.
- Physical damage to hardware components (Arduino, ESP32, coin acceptors).

This limitation applies regardless of the form of action (contract, tort,
negligence, or otherwise) even if the authors have been advised of the
possibility of such damage.

---

## 4. Hardware & Electrical Safety

PrintBit integrates with physical hardware including coin acceptors, hoppers,
Arduino microcontrollers, and ESP32 modules. Deployers are solely responsible
for:

- Safe electrical wiring and enclosure of all hardware.
- Compliance with local electrical codes and safety standards.
- Regular maintenance and inspection of coin-handling mechanisms.
- Preventing unauthorized physical access to the kiosk internals.

The authors assume no liability for electrical hazards, hardware damage, or
injury arising from improper hardware installation or operation.

---

## 5. Financial Transactions

PrintBit handles physical coin-based payments. The authors make no
representations regarding the reliability or auditability of coin transaction
records for commercial, legal, or tax purposes. Operators are responsible
for maintaining their own financial records and complying with applicable
regulations.

---

## 6. Data & Privacy

PrintBit temporarily stores uploaded documents on the host file system for
the duration of a print session. Operators are responsible for:

- Configuring appropriate file retention and deletion policies.
- Informing end users about data handling practices (see `SECURITY.md`).
- Complying with the Philippine Data Privacy Act (Republic Act No. 10173)
  and any other applicable data protection laws.

---

## 7. Third-Party Software

PrintBit relies on third-party open-source software. The authors are not
responsible for vulnerabilities, bugs, or licensing changes in those
dependencies. Operators should monitor upstream advisories for all bundled
packages.

---

## 8. Modifications & Forks

Anyone who modifies or forks PrintBit assumes full responsibility for the
behavior of their derived version. The original authors bear no liability for
forks or derivative works.

---

_By deploying or operating PrintBit, you acknowledge that you have read,
understood, and agreed to this disclaimer._
