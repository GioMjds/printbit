# 🧹 Chore Summary
<!-- Describe what was done and why. e.g. "Bumped express from 4.18 to 4.21 to patch CVE-XXXX" or "Removed unused imports from serial.ts" -->

## 📦 Chore Type
<!-- Check all that apply -->
- [ ] Dependency update (`package.json` / `pnpm-lock.yaml`)
- [ ] TypeScript config change (`tsconfig.json`)
- [ ] Code refactor (no behavior change)
- [ ] Dead code / unused import removal
- [ ] Documentation update (`README.md`, `PRINTBIT_NOTES.txt`, etc.)
- [ ] `.gitignore` or repo config change
- [ ] GitHub Actions / workflow update
- [ ] Other: ______

## 🏗️ Build Impact

- [ ] No build output affected
- [ ] `bundle.js` needs to be regenerated — `pnpm build:client` was run
- [ ] `dist/` output affected — TypeScript recompiled
- [ ] `pnpm-lock.yaml` updated (expected for dependency changes)

## 🔒 TypeScript Strict Mode

- [ ] No `tsconfig.json` changes
- [ ] `tsconfig.json` modified — strict mode implications reviewed
- [ ] New modules follow existing CommonJS import/export style

## 🧪 Safe to Merge Without Hardware Testing?

- [ ] ✅ Yes — no runtime behavior changed
- [ ] ⚠️ No — runtime behavior may be affected, hardware test recommended

## 🔗 Related Issue / Context
<!-- Optional: link a related issue or briefly explain what prompted this chore. -->

## 📝 Additional Notes
<!-- Anything reviewers should know — breaking changes in a dep, migration steps needed, etc. -->