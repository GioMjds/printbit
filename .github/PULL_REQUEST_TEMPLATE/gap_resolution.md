# 🔗 Gap Reference

<!-- Link the issue this PR resolves. e.g. Closes #4 -->
Closes #

## 📌 Gap Title
<!-- e.g. #4 — Secure Payment / Coin Insertion Transaction -->

## ⚠️ Severity
<!-- Check one -->
- [ ] 🔴 Critical
- [ ] 🟠 High
- [ ] 🟡 Medium

## 📝 What Was Done
<!-- Briefly describe what you implemented or changed to resolve this gap. -->

## ✅ Requirements Checklist
<!-- Copy the requirements from the linked issue and check each one off. -->
- [ ] Requirement 1
- [ ] Requirement 2
- [ ] Requirement 3

## 🧩 Affected Area
<!-- Check all that apply -->
- [ ] 🪙 Coin / Payment System
- [ ] 🖨️ Printer / Hardware
- [ ] 🔐 Security / Auth
- [ ] 🖥️ Kiosk UI / UX
- [ ] 🗃️ Backend / API
- [ ] 🛠️ Admin Panel
- [ ] 📡 Network / Connectivity
- [ ] 🗂️ File Handling

## 💾 State Side Effects
<!-- Check all that apply — these touch shared runtime state and need careful review. -->
- [ ] Modifies `db.json` schema or fields (`balance`, `earnings`)
- [ ] Affects `uploads/` directory or file lifecycle
- [ ] Introduces or changes Socket.IO events (list below)
- [ ] Modifies serial port / coin hardware behavior
- [ ] None of the above

<!-- If Socket.IO events were added or changed, list them here: -->

## 🖥️ Frontend Bundle

- [ ] `src/public/app.ts` was **not** modified — no bundle rebuild needed
- [ ] `src/public/app.ts` was modified — `pnpm build:client` was run and `bundle.js` is updated

## 🧪 Hardware Testing

- [ ] Tested against actual coin acceptor / serial hardware
- [ ] Tested against actual printer
- [ ] Hardware not applicable to this gap
- [ ] Unable to test on hardware — reason: ______

## 📸 Screenshots / Logs
<!-- Attach kiosk UI screenshots, terminal output, or serial logs if relevant. -->

## 🚨 Remaining Risks
<!-- Is anything still partially unresolved? Any edge cases left open? -->
