import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { isClamdReachable } from './clamd';

const CLAMD_EXE =
  process.env.CLAMD_EXE_PATH ?? 'C:\\Program Files\\ClamAV\\clamd.exe';

const STARTUP_POLL_INTERVAL_MS = 500;
const STARTUP_TIMEOUT_MS = 15_000;

let clamdProcess: ChildProcess | null = null;

export async function startClamd(): Promise<void> {
  // If already reachable (user started it manually), skip
  if (await isClamdReachable()) {
    console.log('[CLAMD] ✓ Already running — skipping auto-start');
    return;
  }

  if (!fs.existsSync(CLAMD_EXE)) {
    console.warn(`[CLAMD] ⚠ clamd.exe not found at: ${CLAMD_EXE}`);
    console.warn(
      '[CLAMD]   Set CLAMD_EXE_PATH in .env or start ClamAV manually',
    );
    return;
  }

  console.log(`[CLAMD] Starting clamd.exe from ${path.dirname(CLAMD_EXE)}...`);

  clamdProcess = spawn(CLAMD_EXE, [], {
    cwd: path.dirname(CLAMD_EXE),
    detached: false,
    windowsHide: true,
    stdio: 'ignore',
  });

  clamdProcess.on('error', (err) => {
    console.error(`[CLAMD] ✗ Failed to start: ${err.message}`);
    clamdProcess = null;
  });

  clamdProcess.on('exit', (code) => {
    console.warn(`[CLAMD] Process exited with code ${code}`);
    clamdProcess = null;
  });

  // Poll until reachable or timeout
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, STARTUP_POLL_INTERVAL_MS));
    if (await isClamdReachable()) {
      console.log('[CLAMD] ✓ Daemon is ready');
      return;
    }
  }

  console.warn(
    '[CLAMD] ⚠ Timed out waiting for daemon — uploads will be blocked until it responds',
  );
}

export function stopClamd(): void {
  if (!clamdProcess) return;
  clamdProcess.kill();
  clamdProcess = null;
  console.log('[CLAMD] ✗ Stopped');
}
