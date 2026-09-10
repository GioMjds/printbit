import fs from 'fs';
import path from 'path';

describe('printing progress modal', () => {
  const html = fs.readFileSync(
    path.join(process.cwd(), 'src/public/confirm/index.html'),
    'utf8',
  );
  const styles = fs.readFileSync(
    path.join(process.cwd(), 'src/public/confirm/styles.css'),
    'utf8',
  );
  const app = fs.readFileSync(
    path.join(process.cwd(), 'src/public/confirm/app.ts'),
    'utf8',
  );

  test('exposes an accessible determinate progress bar', () => {
    expect(html).toMatch(
      /id="printingProgressBar"[\s\S]*?role="progressbar"[\s\S]*?aria-valuemin="0"[\s\S]*?aria-valuemax="100"[\s\S]*?aria-valuenow="0"/,
    );
  });

  test('uses a full-width track and transform-based fill', () => {
    expect(styles).toMatch(
      /\.printing-progress-bar\s*\{[\s\S]*?width:\s*min\(100%,\s*360px\)/,
    );
    expect(styles).toMatch(
      /\.printing-progress-bar__fill\s*\{[\s\S]*?transform:\s*scaleX\(var\(--progress-scale,\s*0\)\)/,
    );
  });

  test('renders raw worker progress without waiting for lifecycle persistence', () => {
    expect(app).toMatch(
      /connectedSocket\.on\('workerPrintProgress',[\s\S]*?renderPrintProgress\(/,
    );
  });

  test('shows staff-assisted recovery when the worker reports an ambiguous terminal failure', () => {
    expect(app).toMatch(
      /function renderAmbiguousWorkerFailure[\s\S]*?code:\s*'WORKER_PRINT_FAILED'[\s\S]*?renderPrinterError\(/,
    );
    expect(app).toMatch(
      /connectedSocket\.on\('workerPrintFailed',[\s\S]*?renderAmbiguousWorkerFailure\(/,
    );
  });
});
