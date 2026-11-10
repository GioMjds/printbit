import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AnalysisWorkerUnavailableError,
  canAnalyzeInWorker,
  runAnalysisInWorker,
} from './document-analysis-thread';

describe('runAnalysisInWorker', () => {
  let dir: string;

  const writeWorker = (name: string, body: string): string => {
    const scriptPath = path.join(dir, name);
    fs.writeFileSync(
      scriptPath,
      `const { parentPort, workerData } = require('node:worker_threads');\n${body}\n`,
    );
    return scriptPath;
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'printbit-thread-spec-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves with the result the worker posts and passes the input through', async () => {
    const script = writeWorker(
      'ok.js',
      `parentPort.postMessage({ type: 'success', result: { echoed: workerData } });`,
    );

    await expect(
      runAnalysisInWorker(script, { filePath: 'a.pdf', filename: 'a.pdf' }),
    ).resolves.toEqual({ echoed: { filePath: 'a.pdf', filename: 'a.pdf' } });
  });

  it('rejects with the analysis error the worker reports', async () => {
    const script = writeWorker(
      'analysis-error.js',
      `parentPort.postMessage({ type: 'error', message: 'Invalid PDF structure' });`,
    );

    const failure = runAnalysisInWorker(script, { filePath: 'a.pdf' });
    await expect(failure).rejects.toThrow('Invalid PDF structure');
    await expect(failure).rejects.not.toBeInstanceOf(
      AnalysisWorkerUnavailableError,
    );
  });

  it('reports a worker that crashes as unavailable', async () => {
    const script = writeWorker('crash.js', `throw new Error('native module failed');`);

    await expect(
      runAnalysisInWorker(script, { filePath: 'a.pdf' }),
    ).rejects.toBeInstanceOf(AnalysisWorkerUnavailableError);
  });

  it('reports a worker that exits without answering as unavailable', async () => {
    const script = writeWorker('silent.js', `process.exit(0);`);

    await expect(
      runAnalysisInWorker(script, { filePath: 'a.pdf' }),
    ).rejects.toBeInstanceOf(AnalysisWorkerUnavailableError);
  });
});

describe('canAnalyzeInWorker', () => {
  it('accepts PDFs and images, which need no conversion callback', () => {
    expect(canAnalyzeInWorker({ filePath: 'C:/x/doc.pdf' })).toBe(true);
    expect(
      canAnalyzeInWorker({ filePath: 'C:/x/photo.jpg', contentType: 'image/jpeg' }),
    ).toBe(true);
    expect(
      canAnalyzeInWorker({ filePath: 'C:/x/doc.PDF', originalFileType: 'docx' }),
    ).toBe(true);
  });

  it('keeps office files and custom converters on the calling thread', () => {
    expect(canAnalyzeInWorker({ filePath: 'C:/x/doc.docx' })).toBe(false);
    expect(
      canAnalyzeInWorker({
        filePath: 'C:/x/doc.pdf',
        convertToPdfPreview: async (p: string) => p,
      }),
    ).toBe(false);
  });
});
