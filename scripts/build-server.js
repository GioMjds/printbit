const path = require('node:path');
const { execSync } = require('node:child_process');

const esbuildCmd = process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild';
const esbuildPath = path.resolve(__dirname, '..', 'node_modules', '.bin', esbuildCmd);

const nativePackages = [
  'sharp',
  'canvas',
  'argon2',
];

// The analysis worker is a separate bundle: the server starts it in a worker
// thread, so it must not contain (and re-run) the server itself.
const args = [
  'src/server.ts',
  'src/services/document-analysis-worker.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  ...(nativePackages.map((pkg) => `--external:${pkg}`)),
  '--packages=external',
  '--target=node22',
  '--outdir=dist',
  '--entry-names=[name]',
];

const fullCommand = `"${esbuildPath}" ${args.join(' ')}`;
console.log(`[BUILD] Running: ${fullCommand}`);

try {
  execSync(fullCommand, { stdio: 'inherit' });
  console.log('[BUILD] Server build completed successfully.');
} catch (error) {
  console.error('[BUILD] Server build failed.');
  process.exit(error.status || 1);
}
