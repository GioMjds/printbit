# Potential Gaps for **PrintBit**

## 1\. Ink Monitoring: **HIGH**

* End users should not discover low/no ink after paying. A pre-print ink check (or at least an admin-facing ink alert) is a critical Quality of Life and reliability feature.

## 2\. Android \& iOS "Print" Method Flow: **HIGH**

* If users print from mobile browsers on different OS, the file-to-print pipeline may behave differently. This needs OS-aware handling, especially for how files are passed to the backend.

## 3\. Admin Anomaly Notifications: **HIGH**

* No notification system means admins are blind to machine issues until someone reports them in person. An alert via SMS, email, or dashboard push is a standard requirement for unattended kiosk systems.

## 4\. Secure Payment / Coin Insertion Transaction: **CRITICAL**

* This is the core mechanic of your kiosk. Without proper validation (e.g., debouncing coin signals, atomic transaction logic), users can be overcharged or undercharged. Needs hardware-software sync with error rollback.

## 5\. Printer Malfunction / Replacement Handling: **CRITICAL**

* If the printer fails mid-job, the system must gracefully cancel the session, log the error, and either notify the admin or display a clear message to the user with a defined refund/retry policy.

## 6\. Paper Jam \& Refund Policy: **CRITICAL**

* A paper jam mid-print is a *real* UX crisis. The system currently has no documented refund mechanism, which is a serious gap for a coin-based system. This requires both a hardware detection hook and a defined business rule.

## 7\. Why Session-Based for **Print** Method? **HIGH**

* This is a valid architectural question. Session-based printing has timeout risks — if the session expires mid-flow (e.g., slow coin insertion), the user's upload is lost. This needs clear documentation and timeout UX handling.

## 8\. User Undecided During File Upload: **HIGH**

* If a user abandons the upload flow midway, the system needs a timeout + cleanup mechanism to release resources and reset state for the next user.

## 9\. User Queuing: **MEDIUM**

* Without a queue, multiple users approaching the kiosk simultaneously creates undefined behavior. A visual queue or "kiosk busy" state is needed for public deployment.

## 10\. User Surveilance / Logging: **MEDIUM**

* For security and accountability in a public kiosk, session logging (not full surveillance, but transaction audit trails) is important — especially for dispute resolution.

## 11\. Printer Detection / Status for End Users: **CRITICAL**

* The kiosk must detect whether the printer is online, out of paper, or jammed before a user starts a transaction — not after. This is a pre-flight check requirement.

## 12\. Grayscale File Detection: **HIGH**

* Automatically detecting if an uploaded document is already grayscale and disabling the "color" option is a UX and pricing fairness requirement. Without it, users may accidentally pay more for color on a B&W document.

## 13\. User Feedback / Report Submission: **MEDIUM**

* A simple in-kiosk or QR-based feedback form helps you identify real-world issues you wouldn't catch in dev. This is low priority but high value post-launch.

## 14\. Power Loss, Reboot & Crash Discovery: **CRITICAL**

* System should recover to a clean kiosk-ready state after sudden shutdown, battery drain, or app crash. Include auto-start, session recovery rules, and partial-transaction reconciliation.

## 15\. Windows Kiosk Lockdown: **CRITICAL**

* Use Assigned Access or Shell Launcher, disable task switching and notifications, block USB mass storage if needed, disable unnecessary settings access, and prevent users from escaping the kiosk app.

## 16\. Controlled Windows and Driver Updates: **HIGH**

* Unplanned Windows or printer-driver updates can break printing. Define maintenance windows, staged rollout, rollback plan, and version pinning for critical dependencies.

## 17\. Watchdog and Self-Healing: **CRITICAL**

* If app, browser, printer service, or serial listener hangs, auto-restart them. Add heartbeat checks and a local watchdog service.

## 18\. Offline and Intermittent Network Mode: **HIGH**

* Decide exactly what still works without internet (local printing, coin handling, receipts, logs). Queue uploads and telemetry for sync when connection returns.

## 19\. Secure Admin Access and RBAC: **CRITICAL**

* Admin portal should require strong auth, role-based permissions, session timeout, lockout policy, and optional MFA for remote access.

## 20\. Tamper & Physical Security: **HIGH**

* Protect coin box, ports, power cable, and tablet enclosure. Detect door-open or service-panel events where possible and log them.

## 21\. Reconciliation and Financial Audit: **CRITICAL**

* Daily reconciliation between coin intake, completed jobs, refunds, and settlement totals. This is essential for dispute handling and anti-fraud checks.

## 22\. Receipt & Transaction Reference: **HIGH**

* Give users a transaction ID (on-screen and optional QR/SMS) for refund claims and support traceability.

## 23\. Data Retention & Privacy Policy: **HIGH**

* Define what user files, logs, and metadata are stored, for how long, and when they are deleted. Include compliance posture and consent text.

## 24\. File Security & Malware Scanning: **CRITICAL**

* Uploaded files should be validated, scanned, size-limited, and type-restricted. Prevent malicious or malformed files from reaching print pipeline.

## 25\. Page Count & Cost Pre-Calculation: **CRITICAL**

* Before payment completion, show verified page count, color/BW classification, duplex option, and exact price to avoid billing disputes.

## 26\. Accessibility & Language Support: **MEDIUM**

* Large touch targets, high contrast, screen-reader considerations where possible, and multilingual flow for public deployments.

## 27\. Consumables Forecasting: **MEDIUM**

* Beyond ink alerts, forecast paper and ink depletion trends from usage history to schedule proactive maintenance.

## 28\. Time Sync & Trusted Timestamps: **HIGH**

* Use reliable clock sync for logs, settlements, and incident timelines. Unsynced time causes audit and legal issues.

## 29\. Remote Monitoring Dashboard: **HIGH**

* Fleet view of kiosk health: online status, printer status, coin device status, error rate, last successful print, storage usage, and alerts.

## 30\. On-Site SOP & Service Mode: **MEDIUM**

* Document technician workflows: paper refill, coin jam clearing, printer replacement, test print, refund execution, and safe restart procedure.

## 31\. Abuse & Queue Fairness Controls: **MEDIUM**

* Rate limits, max job size, cooldowns, and timeout behavior to prevent one user from monopolizing kiosk capacity.

## 32\. Environmental & Thermal Constraints: **MEDIUM**

* Tablet and printer thermal monitoring in enclosed kiosks; overheating can cause intermittent failures and print defects.

## 33\. Pilot Metrics & Acceptance Criteria: **MEDIUM**

* Define success metrics before rollout: print success rate, refund rate, mean recovery time, admin response time, and customer complaint rate.

## Documentation baseline recommendation

Before closing deployment-critical gaps, maintain an updated dependency and environment baseline in [INSTALLATION_AND_DEPENDENCIES.md](./INSTALLATION_AND_DEPENDENCIES.md).
