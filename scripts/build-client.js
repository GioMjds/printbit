const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

function copyDotLottieWasm() {
  const sourcePath = path.resolve(
    'node_modules',
    '@lottiefiles',
    'dotlottie-web',
    'dist',
    'dotlottie-player.wasm',
  );
  const targetPath = path.resolve(
    'src',
    'public',
    'vendor',
    'dotlottie',
    'dotlottie-player.wasm',
  );
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    console.log(`Copied: ${sourcePath} -> ${targetPath}`);
  } catch (err) {
    console.warn(`Could not copy dotlottie wasm (ignoring): ${err.message}`);
  }
}

const entryPoints = [
  { in: 'src/public/app.ts', out: 'src/public/bundle.js' },
  { in: 'src/public/print/app.ts', out: 'src/public/print/app.js' },
  { in: 'src/public/copy/app.ts', out: 'src/public/copy/app.js' },
  { in: 'src/public/config/app.ts', out: 'src/public/config/app.js' },
  { in: 'src/public/confirm/app.ts', out: 'src/public/confirm/app.js' },
  { in: 'src/public/upload/app.ts', out: 'src/public/upload/app.js' },
  { in: 'src/public/scan/app.ts', out: 'src/public/scan/app.js' },
  { in: 'src/public/feedback/app.ts', out: 'src/public/feedback/app.js' },
  { in: 'src/public/loading/app.ts', out: 'src/public/loading/app.js' },
  { in: 'src/public/receipt/app.ts', out: 'src/public/receipt/app.js' },
  { in: 'src/public/scc/app.ts', out: 'src/public/scc/app.js' },
  { in: 'src/public/admin/dashboard/app.ts', out: 'src/public/admin/dashboard/app.js' },
  { in: 'src/public/admin/earnings/app.ts', out: 'src/public/admin/earnings/app.js' },
  { in: 'src/public/admin/system/app.ts', out: 'src/public/admin/system/app.js' },
  { in: 'src/public/admin/settings/app.ts', out: 'src/public/admin/settings/app.js' },
  { in: 'src/public/admin/logs/app.ts', out: 'src/public/admin/logs/app.js' },
  { in: 'src/public/admin/transactions/app.ts', out: 'src/public/admin/transactions/app.js' },
  { in: 'src/public/admin/feedback/app.ts', out: 'src/public/admin/feedback/app.js' },
  { in: 'src/public/report/app.ts', out: 'src/public/report/app.js' },
  { in: 'src/public/admin/report/app.ts', out: 'src/public/admin/report/app.js' },
  { in: 'src/public/admin/alerts/app.ts', out: 'src/public/admin/alerts/app.js' },
];

function ensurePwaIcons() {
  const iconPath = path.resolve('src', 'public', 'admin', 'icons', 'icon-192x192.png');
  if (!fs.existsSync(iconPath)) {
    console.log('PWA icons missing, generating PWA icons...');
    try {
      require('./generate-pwa-icons');
    } catch (err) {
      console.warn(`Could not generate PWA icons: ${err.message}`);
    }
  }
}

try {
  copyDotLottieWasm();
  ensurePwaIcons();
  for (const entry of entryPoints) {
    console.log(`Building: ${entry.in} -> ${entry.out}`);
    esbuild.buildSync({
      entryPoints: [path.resolve(entry.in)],
      bundle: true,
      outfile: path.resolve(entry.out),
      minify: true,
    });
  }
  console.log('Build completed successfully.');
} catch (error) {
  console.error('Build failed:', error);
  process.exit(1);
}
