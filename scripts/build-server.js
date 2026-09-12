const path = require('node:path');
const { execSync } = require('node:child_process');

const esbuildCmd = process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild';
const esbuildPath = path.resolve(__dirname, '..', 'node_modules', '.bin', esbuildCmd);

const args = [
  'src/server.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--packages=external',
  '--target=node22',
  '--outfile=dist/server.js',
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
