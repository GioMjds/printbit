import { apiFetch, peso, setMessage } from '../admin/shared';
import {
  buildConfirmBody,
  buildQuoteBody,
  shouldRetryQuote,
  type DirectPrintOptions,
} from './direct-print-request';

const QUOTE_RETRY_DELAY_MS = 1500;

type SessionResponse = { sessionId: string; token: string };
type QuotePayload = {
  quote?: { requiredAmount: number; selectedPages: number };
  error?: string;
  code?: string;
};

/** crypto.randomUUID needs a secure context; /scc is served over plain HTTP on the LAN. */
function randomId(): string {
  return typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const clientId = randomId();

const state = {
  sessionId: null as string | null,
  token: '',
  documentId: null as string | null,
  price: null as number | null,
  idempotencyKey: null as string | null,
  spoolerCorrelationKey: null as string | null,
  quoteVersion: 0,
  busy: false,
};

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const fileInput = el<HTMLInputElement>('directFile');
const copiesInput = el<HTMLInputElement>('directCopies');
const colorSelect = el<HTMLSelectElement>('directColor');
const paperSelect = el<HTMLSelectElement>('directPaper');
const orientationSelect = el<HTMLSelectElement>('directOrientation');
const qualitySelect = el<HTMLSelectElement>('directQuality');
const pageRangeInput = el<HTMLInputElement>('directPageRange');
const duplexInput = el<HTMLInputElement>('directDuplex');
const priceEl = el<HTMLElement>('directPrice');
const statusEl = el<HTMLElement>('directStatus');
const printBtn = el<HTMLButtonElement>('directPrintBtn');
const resetBtn = el<HTMLButtonElement>('directResetBtn');

function readOptions(): DirectPrintOptions {
  return {
    copies: Number.parseInt(copiesInput.value, 10) || 1,
    colorMode: colorSelect.value === 'colored' ? 'colored' : 'grayscale',
    paperSize:
      paperSelect.value === 'Short' || paperSelect.value === 'Long'
        ? paperSelect.value
        : 'A4',
    duplex: duplexInput.checked,
    quality: qualitySelect.value === 'high' ? 'high' : 'standard',
    orientation:
      orientationSelect.value === 'landscape' ? 'landscape' : 'portrait',
    pageRange: pageRangeInput.value,
  };
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

function syncPrintButton(): void {
  printBtn.disabled = state.busy || !state.documentId || state.price === null;
}

function invalidateJob(): void {
  // New file or new options: new price and a new payment attempt.
  state.price = null;
  state.idempotencyKey = null;
  state.spoolerCorrelationKey = null;
  priceEl.textContent = '—';
  syncPrintButton();
}

function forgetSession(): void {
  state.sessionId = null;
  state.token = '';
  state.documentId = null;
  invalidateJob();
}

async function ensureSession(): Promise<SessionResponse> {
  if (state.sessionId)
    return { sessionId: state.sessionId, token: state.token };
  const res = await apiFetch('/api/wireless/sessions');
  if (!res.ok)
    throw new Error(`Could not open an upload session (HTTP ${res.status}).`);
  const session = (await res.json()) as SessionResponse;
  state.sessionId = session.sessionId;
  state.token = session.token;
  return session;
}

async function uploadSelectedFile(): Promise<void> {
  const file = fileInput.files?.[0];
  state.documentId = null;
  invalidateJob();
  if (!file) return;

  state.busy = true;
  syncPrintButton();
  setStatus(`Uploading ${file.name}…`);
  try {
    const session = await ensureSession();
    const form = new FormData();
    form.append('file', file);
    // Raw fetch: apiFetch would force a JSON Content-Type onto the multipart body.
    const res = await fetch(
      `/api/wireless/sessions/${encodeURIComponent(session.sessionId)}/upload?token=${encodeURIComponent(session.token)}`,
      {
        method: 'POST',
        body: form,
        headers: { 'x-upload-client-id': clientId },
        credentials: 'include',
      },
    );
    if (res.status === 410) {
      forgetSession();
      throw new Error('Upload session expired. Choose the file again.');
    }
    const payload = (await res.json().catch(() => ({}))) as {
      documentId?: string;
      fileName?: string;
      error?: string;
    };
    if (!res.ok || !payload.documentId) {
      throw new Error(payload.error ?? `Upload failed (HTTP ${res.status}).`);
    }
    state.documentId = payload.documentId;
    setStatus(`Uploaded ${payload.fileName ?? file.name}. Calculating price…`);
  } catch (error) {
    setStatus('');
    setMessage(error instanceof Error ? error.message : 'Upload failed.');
    return;
  } finally {
    state.busy = false;
    syncPrintButton();
  }
  await refreshQuote();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function refreshQuote(): Promise<void> {
  invalidateJob();
  if (!state.sessionId || !state.documentId) return;
  const version = ++state.quoteVersion;
  const body = JSON.stringify(
    buildQuoteBody(state.sessionId, state.documentId, readOptions()),
  );

  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch('/api/print/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (version !== state.quoteVersion) return;
    const payload = (await res.json().catch(() => ({}))) as QuotePayload;
    const code = typeof payload.code === 'string' ? payload.code : null;

    if (shouldRetryQuote(res.status, code, attempt)) {
      setStatus('Analyzing pages…');
      await delay(QUOTE_RETRY_DELAY_MS);
      if (version !== state.quoteVersion) return;
      continue;
    }
    if (res.status === 410) {
      forgetSession();
      setMessage('Upload session expired. Choose the file again.');
      return;
    }
    if (!res.ok || !payload.quote) {
      setStatus('');
      setMessage(
        payload.error ?? `Could not calculate price (HTTP ${res.status}).`,
      );
      return;
    }
    state.price = payload.quote.requiredAmount;
    priceEl.textContent = peso(payload.quote.requiredAmount);
    setStatus(`${payload.quote.selectedPages} page(s) selected.`);
    syncPrintButton();
    return;
  }
}

async function printDirect(): Promise<void> {
  if (!state.sessionId || !state.documentId || state.price === null) return;
  state.busy = true;
  syncPrintButton();
  // Same key on retry of the same job, so the server dedupes double submits.
  const idempotencyKey = (state.idempotencyKey ??= randomId());
  const spoolerCorrelationKey = (state.spoolerCorrelationKey ??= randomId());
  const price = state.price;
  setStatus('Sending to printer…');

  try {
    const res = await apiFetch('/api/admin/direct-print/confirm', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(
        buildConfirmBody(
          state.sessionId,
          state.documentId,
          readOptions(),
          spoolerCorrelationKey,
        ),
      ),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      chargedAmount?: number;
      error?: string;
      message?: string;
    };
    if (!res.ok) {
      throw new Error(
        payload.error ??
          payload.message ??
          `Print failed (HTTP ${res.status}).`,
      );
    }
    setStatus(
      `Queued. ${peso(payload.chargedAmount ?? price)} recorded as direct earnings.`,
    );
    // Printed once: block a second accidental print of the same job.
    state.documentId = null;
    invalidateJob();
  } catch (error) {
    setStatus('');
    setMessage(error instanceof Error ? error.message : 'Print failed.');
  } finally {
    state.busy = false;
    syncPrintButton();
  }
}

function resetJob(): void {
  forgetSession();
  fileInput.value = '';
  copiesInput.value = '1';
  pageRangeInput.value = '';
  duplexInput.checked = false;
  setStatus('');
}

export function initDirectPrint(): void {
  fileInput.addEventListener('change', () => {
    void uploadSelectedFile();
  });
  for (const input of [
    copiesInput,
    colorSelect,
    paperSelect,
    orientationSelect,
    qualitySelect,
    pageRangeInput,
    duplexInput,
  ]) {
    input.addEventListener('change', () => {
      void refreshQuote();
    });
  }
  printBtn.addEventListener('click', () => {
    void printDirect();
  });
  resetBtn.addEventListener('click', resetJob);
}
