export {};
import { initKioskLocalization } from '../shared/kiosk-i18n';

void initKioskLocalization();

declare global {
  interface Window {
    feedbackToken?: string;
  }
}

type AppState = 'loading' | 'ready' | 'submitting' | 'done' | 'error';

const CATEGORIES = [
  { value: 'service', label: 'Service' },
  { value: 'print', label: 'Printing' },
  { value: 'copy', label: 'Copying' },
  { value: 'scan', label: 'Scanning' },
  { value: 'payment', label: 'Payment' },
  { value: 'hardware', label: 'Hardware' },
  { value: 'software', label: 'Software' },
  { value: 'other', label: 'Other' },
] satisfies { value: string; label: string }[];

// ── DOM refs ──────────────────────────────────────────────────────────────────

const stateLoading = document.getElementById('stateLoading') as HTMLElement;
const stateError = document.getElementById('stateError') as HTMLElement;
const stateForm = document.getElementById('stateForm') as HTMLElement;
const stateDone = document.getElementById('stateDone') as HTMLElement;
const feedbackForm = document.getElementById('feedbackForm') as HTMLFormElement;
const commentInput = document.getElementById('commentInput') as HTMLTextAreaElement;
const commentCounter = document.getElementById('commentCounter') as HTMLElement;
const categoryChips = document.getElementById('categoryChips') as HTMLElement;
const starRow = document.getElementById('starRow') as HTMLElement;
const submitBtn = document.getElementById('submitBtn') as HTMLButtonElement;
const formMsg = document.getElementById('formMsg') as HTMLElement;

// ── State ─────────────────────────────────────────────────────────────────────

let selectedCategory: string | null = null;
let selectedRating: number | null = null;

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
    state === 'submitting' ? 'Sending…' : 'Send Feedback';
}

// ── Category chips ────────────────────────────────────────────────────────────

function buildCategoryChips(): void {
  for (const cat of CATEGORIES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = cat.label;
    btn.dataset.value = cat.value;
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      const isActive = selectedCategory === cat.value;
      selectedCategory = isActive ? null : cat.value;
      categoryChips
        .querySelectorAll<HTMLButtonElement>('.chip')
        .forEach((c) => {
          const active = c.dataset.value === selectedCategory;
          c.classList.toggle('chip--active', active);
          c.setAttribute('aria-pressed', String(active));
        });
    });
    categoryChips.appendChild(btn);
  }
}

// ── Star rating ───────────────────────────────────────────────────────────────

function applyStars(
  stars: NodeListOf<HTMLButtonElement>,
  value: number | null,
): void {
  stars.forEach((s) => {
    const v = Number(s.dataset.value);
    s.classList.toggle('star-btn--filled', value !== null && v <= value);
  });
}

function buildStarRating(): void {
  const stars = starRow.querySelectorAll<HTMLButtonElement>('.star-btn');
  stars.forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = Number(btn.dataset.value);
      selectedRating = selectedRating === val ? null : val;
      applyStars(stars, selectedRating);
    });
    btn.addEventListener('mouseenter', () => {
      applyStars(stars, Number(btn.dataset.value));
    });
  });
  starRow.addEventListener('mouseleave', () => {
    applyStars(stars, selectedRating);
  });
}

// ── Comment counter ───────────────────────────────────────────────────────────

commentInput.addEventListener('input', () => {
  commentCounter.textContent = `${commentInput.value.length} / 1200`;
});

// ── Form submit ───────────────────────────────────────────────────────────────

feedbackForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const comment = commentInput.value.trim();
  if (!comment) {
    formMsg.textContent = 'Please write a comment before submitting.';
    return;
  }
  formMsg.textContent = '';
  void submitFeedback(comment);
});

async function submitFeedback(comment: string): Promise<void> {
  setState('submitting');
  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        comment,
        category: selectedCategory,
        rating: selectedRating,
      }),
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      formMsg.textContent =
        body.error ?? 'Submission failed. Please try again.';
      setState('ready');
      return;
    }
    setState('done');
  } catch {
    formMsg.textContent =
      'Network error. Please check your connection and try again.';
    setState('ready');
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

buildCategoryChips();
buildStarRating();
setState('ready');
