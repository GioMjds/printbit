const esbuild = require('esbuild');
const { spawn } = require('child_process');

async function dev() {
  let nodeProcess = null;
  let started = false;

  console.log('[DEV-SERVER] Initializing fast esbuild watcher for PrintBit...');

  const ctx = await esbuild.context({
    // The analysis worker is its own bundle; the server runs it in a thread.
    entryPoints: ['src/server.ts', 'src/services/document-analysis-worker.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    target: 'node22',
    outdir: 'dist',
    entryNames: '[name]',
    sourcemap: 'inline',
    plugins: [
      {
        name: 'on-rebuild',
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length > 0) {
              console.error('[DEV-SERVER] Build encountered errors.');
              return;
            }
            if (!started) {
              started = true;
              console.log('[DEV-SERVER] Initial build successful. Launching Node server...');
              startNodeServer();
            } else {
              console.log('[DEV-SERVER] Rebuild complete. Server reloading...');
            }
          });
        },
      },
    ],
  });

  function startNodeServer() {
    nodeProcess = spawn('node', ['--watch', 'dist/server.js'], {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: process.env.NODE_ENV || 'development',
      },
    });

    nodeProcess.on('exit', (code) => {
      if (code && code !== 0) {
        console.log(`[DEV-SERVER] Server process exited with code ${code}`);
      }
    });
  }

  await ctx.watch();

  function cleanup() {
    void ctx.dispose().finally(() => {
      if (nodeProcess) {
        nodeProcess.kill();
      }
      process.exit(0);
    });
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

dev().catch((err) => {
  console.error('[DEV-SERVER] Failed to start:', err);
  process.exit(1);
});
