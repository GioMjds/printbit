# 🐛 Bug Description
<!-- Describe the bug that was fixed. What was happening, and where? -->

## 🔁 Steps to Reproduce (Before Fix)

1.
2.
3.

## 🔍 Root Cause
<!-- What caused the bug? e.g. Race condition in coin event handler, unhandled multer error, missing balance guard, etc. -->

## 🛠️ What Was Changed
<!-- Describe the fix. Keep it focused — what exactly did you change and why does it resolve the root cause? -->

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

## ⚠️ Regression Risk
<!-- Does this fix touch anything that could break adjacent behavior? Check all that apply. -->
- [ ] Touches payment / coin flow (`balance`, `earnings`, serial events)
- [ ] Touches print dispatch or `POST /print` route
- [ ] Touches session / upload handling (`session.ts`, `multer`, `POST /upload`)
- [ ] Touches Socket.IO event emission
- [ ] Low risk — isolated change

## 💾 State Verification

- [ ] `db.json` state manually verified as correct after the fix
- [ ] `uploads/` directory behavior unaffected
- [ ] Not applicable — fix does not touch runtime state

## 🖥️ Frontend Bundle

- [ ] `src/public/app.ts` was **not** modified — no bundle rebuild needed
- [ ] `src/public/app.ts` was modified — `pnpm build:client` was run and `bundle.js` is updated

## 🧪 Testing

- [ ] Manually confirmed the bug no longer reproduces
- [ ] Tested against hardware (coin / printer) if applicable
- [ ] Verified adjacent flows still work correctly

## 📸 Screenshots / Logs
<!-- Attach before/after screenshots, terminal output, or serial logs that confirm the fix. -->

## 🔗 Related Issue
<!-- Link the issue if one exists, or note that this was an untracked runtime discovery. -->
Fixes # _(if tracked)_ / Untracked runtime bug
