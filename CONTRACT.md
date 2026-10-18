# PrintBit Kiosk Placement, Licensing & Service Agreement

**Document Version:** 1.0  
**Effective Date:** October 18, 2026
**Governing Jurisdiction:** Republic of the Philippines

---

## 1. Parties and Purpose

This Agreement is made and entered into by and between:

- **PrintBit Development Team ("Licensor" / "Service Provider")**, represented by its project contributors and lead developers, having intellectual property and operational control of the PrintBit hardware, firmware, and software ecosystem.
- **The Host Institution / Venue Operator ("Host" / "Licensee")**, being the commercial establishment, educational institution, library, or property manager where the PrintBit kiosk hardware unit is installed and operated.

Collectively referred to as the **"Parties"** or individually as a **"Party"**.

**WHEREAS**, Licensor designs, develops, and maintains PrintBit, a self-service coin-operated document printing, copying, and scanning kiosk system comprising proprietary software, ESP32 firmware, and dedicated kiosk hardware; and  
**WHEREAS**, Host desires to grant floor space and utilities on its premises to operate a PrintBit kiosk for self-service document printing by students, visitors, or customers, subject to the terms and conditions outlined herein.

NOW, THEREFORE, in consideration of the mutual covenants contained herein, the Parties agree as follows:

---

## 2. Scope of Services & License

### 2.1 Software & Firmware License

1. Licensor grants Host a non-exclusive, non-transferable, revocable license to utilize the PrintBit software suite, kiosk user interface, administrative dashboard, and ESP32 firmware solely on designated PrintBit hardware units deployed at approved Host premises.
2. The license explicitly excludes any right to sublicense, distribute, modify, reverse-engineer, decompile, or create derivative works from the software or firmware.

### 2.2 Hardware Deployment

1. Licensor shall deliver, assemble, and configure the PrintBit kiosk unit (chassis, industrial PC, thermal/inkjet/laser printer, optical scanner, multi-coin acceptor, coin hopper, power safety modules, and wireless access point).
2. Host shall provide a secure, level indoor location with adequate ventilation, ambient lighting, and pedestrian clearance.

---

## 3. Host Venue Requirements & Obligations

Host agrees to provide and maintain the following operational environment at its sole expense:

1. **Power Supply**: One dedicated, grounded 220V AC, 60Hz power outlet providing uninterrupted clean electricity.
2. **Physical Security**: Reasonable care and surveillance to protect the kiosk from vandalism, water damage, theft, physical abuse, or unauthorized relocation.
3. **Environmental Standards**: An indoor environment protected against rainfall, direct sunlight exposure, excess moisture (>85% relative humidity), and extreme temperatures (<15°C or >38°C).
4. **Access Rights**: Unimpeded access for Licensor’s authorized technicians during normal business hours for inspection, routine maintenance, cash collection, and emergency repair.
5. **Consumables Handling** _(if designated in Schedule A)_: Loading authorized paper stock (Short, A4, Long) following Licensor's handling instructions.

---

## 4. Licensor Responsibilities & Technical Support

Licensor agrees to:

1. **Initial Deployment**: Install, calibrate, and verify kiosk hardware, network connectivity (ESP32 SoftAP / Wi-Fi), and peripheral drivers before public operation.
2. **Software Maintenance**: Provide system updates, security patches, scanner driver optimizations, and bug fixes without additional fee.
3. **Consumables & Ink**: Monitor ink/toner levels via automated kiosk telemetry and replace cartridges before service degradation.
4. **Hardware Maintenance**: Repair or replace defective hardware components (coin acceptors, hoppers, power supplies, USB hubs, printer rollers) within forty-eight (48) hours of verified incident notification.
5. **Customer Dispute Resolution**: Process error disputes and refund claims submitted via the kiosk's on-screen QR code and support logging workflow.

---

## 5. Financial Terms, Pricing & Revenue Sharing

### 5.1 Pricing Structure

Document printing, copying, and scanning tariffs shall be set by mutual agreement and stored in the system configuration. Baseline rates adhere to published campus/commercial guidelines:

- Black & White Print / Copy: PhP 2.00 per page (Letter / A4), PhP 3.00 per page (Legal).
- Full Color Print / Copy: PhP 5.00 per page (Letter / A4), PhP 8.00 per page (Legal).
- High-Resolution Scan: PhP 1.00 per page (PDF / JPEG export).

### 5.2 Revenue Share

1. Gross Revenue is defined as all valid coin proceeds collected by the kiosk's multi-coin acceptor, verified against internal transaction logs (`printbit.sqlite`) excluding authorized customer refunds.
2. Revenue sharing shall be distributed on a monthly basis according to the percentage agreed in **Schedule A** (Default: 80% Licensor / 20% Host).
3. Host shall receive an itemized monthly audit report generated from the PrintBit financial service telemetry.

### 5.3 Cash Collection & Vault Handling

1. Kiosk coin vaults are physically locked and keyed separately.
2. Cash emptying and hopper replenishment shall be executed solely by authorized Licensor personnel, or jointly with Host’s designated representative as established in Schedule A.

---

## 6. Intellectual Property & Brand Protection

1. **Sole Ownership**: Licensor and its contributors retain all right, title, and interest in and to the PrintBit software, firmware, electronics schematics, UI components, documentation, trademarks, trade secrets, and patents.
2. **No Ownership Transfer**: Nothing in this Agreement transfers intellectual property ownership to Host or any third party.
3. **Branding Usage**: Host may display the "PrintBit" name and promotional signage solely within the premises to direct customers to the kiosk. Host shall not alter, conceal, or remove proprietary logos or trademark notices affixed to the kiosk cabinet or UI.

---

## 7. Customer Data Protection & Privacy

Both Parties shall strictly adhere to Republic Act No. 10173 (Data Privacy Act of 2012):

1. **Ephemeral File Storage**: PrintBit is designed with automatic local document deletion. Customer documents uploaded for printing are processed in volatile storage and automatically erased post-job completion or upon transaction termination.
2. **Transaction Telemetry**: Only anonymized metadata (job timestamp, page count, color mode, reference code `PB-YYYYMMDD-XXXX`, coin values) is persisted for financial audit purposes.
3. **No Surveillance on Content**: Neither Licensor nor Host shall inspect, intercept, copy, or retain contents of user-submitted documents.

---

## 8. Term, Renewal & Termination

1. **Initial Term**: This Agreement becomes effective on the Effective Date and shall continue for an initial period of twelve (12) calendar months.
2. **Automatic Renewal**: Upon expiration of the Initial Term, this Agreement shall automatically renew for successive twelve (12) month terms unless either Party provides thirty (30) days prior written notice of non-renewal.
3. **Termination for Convenience**: Either Party may terminate this Agreement without cause by giving sixty (60) days prior written notice to the other Party.
4. **Termination for Cause**: Either Party may terminate immediately upon written notice if the other Party:
   - Materially breaches any provision and fails to cure within fifteen (15) days of receiving written notice.
   - Files for bankruptcy, insolvency, or ceases regular business operations.
   - Engages in fraudulent conduct, tampering, or intentional damage to the kiosk or software.
5. **Post-Termination Obligations**: Upon termination, Licensor shall reconcile final revenue balances and remove all hardware units from Host premises within ten (10) business days.

---

## 9. Warranties, Limitation of Liability & Indemnification

1. **As-Is Operational Warranty**: Licensor provides the kiosk hardware and software in good faith, maintaining reasonable industry standards of uptime and reliability. Licensor does not guarantee 100% uninterrupted operation free from mechanical jams or printer hardware wear.
2. **Limitation of Liability**: To the maximum extent permitted under Philippine law, Licensor shall not be liable for any indirect, incidental, punitive, or consequential damages (including lost profits, student academic deadlines, or business interruption) arising from kiosk downtime.
3. **Liability Cap**: Licensor's maximum cumulative liability under this Agreement shall not exceed the total revenue received by Licensor from the specific kiosk unit during the three (3) months preceding the incident.
4. **Indemnification by Host**: Host agrees to indemnify and hold harmless Licensor against third-party claims arising from physical vandalism, tampering, gross negligence, or unauthorized electrical modifications conducted on Host premises.

---

## 10. General Provisions

1. **Governing Law**: This Agreement shall be governed by and construed in accordance with the laws of the Republic of the Philippines.
2. **Dispute Resolution**: Any dispute arising from this Agreement shall first be submitted to mutual amicable consultation. If unresolved after thirty (30) days, the dispute shall be submitted to the competent courts of the venue agreed upon by the Parties.
3. **Entire Agreement**: This Agreement, together with attached schedules, constitutes the entire agreement between the Parties and supersedes all prior proposals, discussions, or understandings.
4. **Amendments**: Any modification or waiver must be in writing and signed by authorized representatives of both Parties.
5. **Severability**: If any provision is deemed invalid or unenforceable, the remaining provisions shall remain in full force and effect.

---

## 11. Schedule A: Deployment Specifications

- **Installation Venue / Address:** `___________________________________`
- **Designated Host Contact Person:** `___________________________________`
- **Contact Number & Email:** `___________________________________`
- **Revenue Split Percentage:** Licensor: `____%` | Host: `____%`
- **Settlement Cycle:** Monthly (Within the first 5 business days of each calendar month)
- **Paper Restocking Responsibility:** [ ] Licensor [ ] Host

---

## Execution and Signatures

IN WITNESS WHEREOF, the Parties hereto have executed this Agreement as of the date first written above.

**FOR LICENSOR / PRINTBIT:**

Signature: `_____________________________________________`  
Name: **Gio Majadas**  
Title: Lead Developer / Project Lead  
Date: `_________________________________________________`

**FOR HOST / VENUE OPERATOR:**

Signature: `_____________________________________________`  
Name: `_________________________________________________`  
Title: `_________________________________________________`  
Entity / Organization: `_________________________________`  
Date: `_________________________________________________`
