import { createIdCaptureClient } from './id-capture';

function reply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function notJson(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
  } as unknown as Response;
}

function setup(outcome: Response | Error) {
  const fetch = jest.fn(
    (): Promise<Response> =>
      outcome instanceof Error
        ? Promise.reject(outcome)
        : Promise.resolve(outcome),
  );
  return {
    fetch,
    capture: createIdCaptureClient({ fetch, timeoutMs: 110_000 }),
  };
}

const sheet = {
  detected: true,
  sessionId: 's-1',
  sides: { front: true, back: false },
  complete: false,
  previewPath: 'id-copy-1.pdf',
  releaseToken: 't-1',
  warnings: [],
};

const frontRequest = {
  sessionId: null,
  side: 'front' as const,
  paperSize: 'A4' as const,
};

describe('scanSide', () => {
  it.each([
    ['front', 'Front scan'],
    ['back', 'Back scan'],
  ] as const)(
    'posts a %s scan with its label and timeout',
    async (side, label) => {
      const { fetch, capture } = setup(reply(200, sheet));
      await capture.scanSide({ sessionId: 's-1', side, paperSize: 'Short' });
      expect(fetch).toHaveBeenCalledWith(
        '/api/scan/id-copy/side',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 's-1', side, paperSize: 'Short' }),
        },
        110_000,
        label,
      );
    },
  );

  it('returns the sheet and its warnings', async () => {
    const warned = {
      ...sheet,
      warnings: [{ code: 'side_blank', side: 'front' }],
    };
    const { capture } = setup(reply(200, warned));
    await expect(capture.scanSide(frontRequest)).resolves.toEqual({
      kind: 'sheet',
      sheet: warned,
    });
  });

  it('treats missing warnings as none', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { warnings: _omitted, ...withoutWarnings } = sheet;
    const { capture } = setup(reply(200, withoutWarnings));
    await expect(capture.scanSide(frontRequest)).resolves.toEqual({
      kind: 'sheet',
      sheet,
    });
  });

  it('drops warnings it does not know', async () => {
    const { capture } = setup(
      reply(200, {
        ...sheet,
        warnings: [
          { code: 'blurry', side: 'front' },
          { code: 'sides_identical', side: 'back' },
        ],
      }),
    );
    const result = await capture.scanSide(frontRequest);
    expect(result.kind === 'sheet' && result.sheet.warnings).toEqual([
      { code: 'sides_identical', side: 'back' },
    ]);
  });

  it('keeps the session id of a failed scan', async () => {
    const { capture } = setup(
      reply(200, {
        detected: false,
        sessionId: 's-1',
        code: 'SCAN_TIMEOUT',
        error: 'Scanner timed out.',
      }),
    );
    await expect(capture.scanSide(frontRequest)).resolves.toEqual({
      kind: 'scan-failed',
      sessionId: 's-1',
      code: 'SCAN_TIMEOUT',
      error: 'Scanner timed out.',
    });
  });

  it('reports an expired session', async () => {
    const { capture } = setup(
      reply(409, {
        code: 'ID_SESSION_EXPIRED',
        error: 'Your ID scan session expired. Please scan your ID again.',
      }),
    );
    await expect(capture.scanSide(frontRequest)).resolves.toEqual({
      kind: 'expired',
      error: 'Your ID scan session expired. Please scan your ID again.',
    });
  });

  it('reports a power emergency', async () => {
    const { capture } = setup(
      reply(503, {
        code: 'POWER_EMERGENCY',
        message: 'Power emergency active; customer work suspended',
      }),
    );
    await expect(capture.scanSide(frontRequest)).resolves.toEqual({
      kind: 'error',
      code: 'POWER_EMERGENCY',
      error: 'Power emergency active; customer work suspended',
    });
  });

  it('reports a rejected request with the server text', async () => {
    const { capture } = setup(
      reply(400, { error: 'Invalid side. Accepted: "front", "back"' }),
    );
    await expect(capture.scanSide(frontRequest)).resolves.toEqual({
      kind: 'error',
      code: 'SCAN_FAILED',
      error: 'Invalid side. Accepted: "front", "back"',
    });
  });

  it('falls back when the body is not JSON', async () => {
    const { capture } = setup(notJson(500));
    await expect(capture.scanSide(frontRequest)).resolves.toEqual({
      kind: 'error',
      code: 'SCAN_FAILED',
      error: 'Could not complete scanner check. Please try again.',
    });
  });

  it('reports a client timeout', async () => {
    const { capture } = setup(
      new Error('Front scan timed out after 110 seconds'),
    );
    await expect(capture.scanSide(frontRequest)).resolves.toEqual({
      kind: 'error',
      code: 'SCANNER_TIMEOUT',
      error: 'Front scan timed out after 110 seconds',
    });
  });

  it('reports a server it cannot reach', async () => {
    const { capture } = setup(new TypeError('Failed to fetch'));
    await expect(capture.scanSide(frontRequest)).resolves.toEqual({
      kind: 'error',
      code: 'SCANNER_OFFLINE',
      error: 'Could not reach the scanner. Please try again.',
    });
  });
});

describe('compose', () => {
  it('posts the paper size and rotations', async () => {
    const { fetch, capture } = setup(reply(200, sheet));
    const result = await capture.compose({
      sessionId: 's-1',
      paperSize: 'Short',
      rotations: { front: 90, back: 0 },
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/scan/id-copy/compose',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: 's-1',
          paperSize: 'Short',
          rotations: { front: 90, back: 0 },
        }),
      },
      110_000,
      'ID sheet',
    );
    expect(result.kind).toBe('sheet');
  });
});
