export {};

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

declare global {
  interface Window {
    reportIssueToken?: string;
  }
}

interface SessionResponse {
  sessionId: string;
  reportUrl: string;
}

interface AttachmentResponse {
  attachmentId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
}

type AppState = 'loading' | 'ready' | 'submitting' | 'done' | 'error';

const MAX_ATTACHMENTS = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const CATEGORIES: Array<{ value: string; label: string }> = [
  { value: 'hardware', label: 'Hardware' },
  { value: 'software', label: 'Software' },
  { value: 'print', label: 'Print' },
  { value: 'copy', label: 'Copy' },
  { value: 'scan', label: 'Scan' },
  { value: 'payment', label: 'Payment' },
  { value: 'network', label: 'Network' },
  { value: 'other', label: 'Other' },
];

// ── DOM refs ──────────────────────────────────────────────────────────────────

const stateLoading = document.getElementById('stateLoading') as HTMLElement;
const stateError = document.getElementById('stateError') as HTMLElement;
const stateForm = document.getElementById('stateForm') as HTMLElement;
const stateDone = document.getElementById('stateDone') as HTMLElement;
const reportForm = document.getElementById('reportForm') as HTMLFormElement;
const titleInput = document.getElementById('titleInput') as HTMLInputElement;
const categoryChips = document.getElementById('categoryChips') as HTMLElement;
const descriptionInput = document.getElementById(
  'descriptionInput',
) as HTMLTextAreaElement;
const descCounter = document.getElementById('descCounter') as HTMLElement;
const imageInput = document.getElementById('imageInput') as HTMLInputElement;
const attachmentList = document.getElementById('attachmentList') as HTMLElement;
const submitBtn = document.getElementById('submitBtn') as HTMLButtonElement;
const formMsg = document.getElementById('formMsg') as HTMLElement;

// ── State ─────────────────────────────────────────────────────────────────────

const token =
  window.reportIssueToken ?? window.location.pathname.split('/')[2] ?? '';
let sessionId: string | null = null;
let selectedCategory: string = 'other';
const attachmentIds: string[] = [];
const attachedFiles: Array<{
  name: string;
  id: string;
  status: 'uploading' | 'done' | 'error';
}> = [];

// ── State switching ───────────────────────────────────────────────────────────

function setState(state: AppState): void {
  stateLoading.classList.toggle('hidden', state !== 'loading');
  stateError.classList.toggle('hidden', state !== 'error');
  stateForm.classList.toggle(
    'hidden',
    state !== 'ready' && state !== 'submitting',
  );
  stateDone.classList.toggle('hidden', state !== 'done');
  submitBtn.disabled = state === 'submitting';
  submitBtn.textContent =
    state === 'submitting' ? 'Submitting…' : 'Submit Report';
}

function setMessage(msg: string, isError = true): void {
  formMsg.textContent = msg;
  formMsg.classList.toggle('rp-msg--error', isError);
}

// ── Category chips ────────────────────────────────────────────────────────────

function buildCategoryChips(): void {
  for (const cat of CATEGORIES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'rp-chip' + (cat.value === selectedCategory ? ' rp-chip--active' : '');
    btn.textContent = cat.label;
    btn.dataset.value = cat.value;
    btn.setAttribute('aria-pressed', String(cat.value === selectedCategory));
    btn.addEventListener('click', () => {
      selectedCategory = cat.value;
      categoryChips
        .querySelectorAll<HTMLButtonElement>('.rp-chip')
        .forEach((c) => {
          const active = c.dataset.value === selectedCategory;
          c.classList.toggle('rp-chip--active', active);
          c.setAttribute('aria-pressed', String(active));
        });
    });
    categoryChips.appendChild(btn);
  }
}

// ── Counter ───────────────────────────────────────────────────────────────────

descriptionInput.addEventListener('input', () => {
  descCounter.textContent = `${descriptionInput.value.length} / 1200`;
});

// ── Attachment list rendering ─────────────────────────────────────────────────

function renderAttachmentList(): void {
  attachmentList.innerHTML = '';
  for (const item of attachedFiles) {
    const div = document.createElement('div');
    div.className = `rp-attachment rp-attachment--${item.status}`;
    div.innerHTML = `
      <span class="rp-attachment__name">${escHtml(item.name)}</span>
      <span class="rp-attachment__status">
        ${item.status === 'uploading' ? '⏳' : item.status === 'done' ? '✓' : '✗'}
      </span>
    `;
    attachmentList.appendChild(div);
  }
}

// ── Single file upload ────────────────────────────────────────────────────────

async function uploadSingleFile(file: File): Promise<void> {
  if (!sessionId) throw new Error('Session unavailable');

  const trackIdx =
    attachedFiles.push({ name: file.name, id: '', status: 'uploading' }) - 1;
  renderAttachmentList();

  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(
    `/api/report-issues/sessions/${encodeURIComponent(sessionId)}/attachments?token=${encodeURIComponent(token)}`,
    { method: 'POST', body: formData },
  );

  if (!res.ok) {
    const body = (await res.json()) as { error?: string };
    attachedFiles[trackIdx].status = 'error';
    renderAttachmentList();
    throw new Error(body.error ?? 'Upload failed');
  }

  const data = (await res.json()) as AttachmentResponse;
  attachmentIds.push(data.attachmentId);
  attachedFiles[trackIdx].id = data.attachmentId;
  attachedFiles[trackIdx].status = 'done';
  renderAttachmentList();
}

// ── Image input handler ───────────────────────────────────────────────────────

imageInput.addEventListener('change', () => {
  const files = Array.from(imageInput.files ?? []);
  imageInput.value = '';
  if (!files.length || !sessionId) return;

  void (async () => {
    for (const file of files) {
      if (attachmentIds.length >= MAX_ATTACHMENTS) {
        setMessage(`Maximum of ${MAX_ATTACHMENTS} images reached.`);
        break;
      }
      if (!ALLOWED_TYPES.has(file.type)) {
        setMessage(`Unsupported type: ${file.name}. Use JPEG, PNG, or WebP.`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        setMessage(
          `${file.name} exceeds the 10 MB limit (${formatBytes(file.size)}).`,
        );
        continue;
      }
      try {
        setMessage(`Uploading ${file.name}…`, false);
        await uploadSingleFile(file);
        setMessage(`${file.name} uploaded.`, false);
      } catch (err) {
        setMessage(err instanceof Error ? err.message : 'Upload failed.');
      }
    }
  })();
});

// ── Session loading ───────────────────────────────────────────────────────────

async function loadSession(): Promise<void> {
  if (!token) {
    setState('error');
    return;
  }

  try {
    const res = await fetch(
      `/api/report-issues/sessions/by-token/${encodeURIComponent(token)}`,
    );
    if (!res.ok) {
      setState('error');
      return;
    }

    const data = (await res.json()) as SessionResponse;
    sessionId = data.sessionId;
    setState('ready');
  } catch {
    setState('error');
  }
}

// ── Form submission ───────────────────────────────────────────────────────────

reportForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!sessionId) return;

  const title = titleInput.value.trim();
  const description = descriptionInput.value.trim();

  if (!title) {
    setMessage('Title is required.');
    return;
  }
  if (!description) {
    setMessage('Description is required.');
    return;
  }

  setMessage('');

  void (async () => {
    setState('submitting');
    try {
      const res = await fetch(
        `/api/report-issues/sessions/${encodeURIComponent(sessionId!)}/submit?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            description,
            category: selectedCategory,
            attachmentIds,
          }),
        },
      );

      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setMessage(body.error ?? 'Submission failed. Please try again.');
        setState('ready');
        return;
      }

      setState('done');
    } catch {
      setMessage('Network error. Please check your connection and try again.');
      setState('ready');
    }
  })();
});

// ── Init ──────────────────────────────────────────────────────────────────────

buildCategoryChips();
void loadSession();
