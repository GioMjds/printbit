const { execSync } = require('child_process');

const builds = [
  'esbuild src/public/app.ts --bundle --outfile=src/public/bundle.js',
  'esbuild src/public/print/app.ts --bundle --outfile=src/public/print/app.js',
  'esbuild src/public/copy/app.ts --bundle --outfile=src/public/copy/app.js',
  'esbuild src/public/config/app.ts --bundle --outfile=src/public/config/app.js',
  'esbuild src/public/confirm/app.ts --bundle --outfile=src/public/confirm/app.js',
  'esbuild src/public/upload/app.ts --bundle --outfile=src/public/upload/app.js',
  'esbuild src/public/scan/app.ts --bundle --outfile=src/public/scan/app.js',
  'esbuild src/public/admin/dashboard/app.ts --bundle --outfile=src/public/admin/dashboard/app.js',
  'esbuild src/public/admin/earnings/app.ts --bundle --outfile=src/public/admin/earnings/app.js',
  'esbuild src/public/admin/coin-stats/app.ts --bundle --outfile=src/public/admin/coin-stats/app.js',
  'esbuild src/public/admin/system/app.ts --bundle --outfile=src/public/admin/system/app.js',
  'esbuild src/public/admin/settings/app.ts --bundle --outfile=src/public/admin/settings/app.js',
  'esbuild src/public/admin/logs/app.ts --bundle --outfile=src/public/admin/logs/app.js',
];

try {
  for (const cmd of builds) {
    console.log(`Running: ${cmd}`);
    execSync(cmd, { stdio: 'inherit' });
  }
  console.log('Build completed successfully.');
} catch (error) {
  console.error('Build failed:', error);
  process.exit(1);
}
