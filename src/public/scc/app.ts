import { initAuth, apiFetch, setMessage, peso } from '../admin/shared';
import { initDirectPrint } from './direct-print';

type Denomination = 'one' | 'five' | 'ten' | 'twenty';
type Counters = Record<Denomination, number>;

const COUNTERS_KEY = 'printbit.secretCoinConsole.counters';

const COIN_VALUE_TO_DENOM = {
  1: 'one',
  5: 'five',
  10: 'ten',
  20: 'twenty',
} as Record<number, Denomination>;

const ZERO_COUNTERS = {
  one: 0,
  five: 0,
  ten: 0,
  twenty: 0,
} as const satisfies Counters;

const mainEl = document.getElementById('coinConsoleMain') as HTMLElement | null;
const authViewEl = document.getElementById(
  'adminAuthView',
) as HTMLElement | null;
const liveBalanceEl = document.getElementById(
  'liveBalance',
) as HTMLElement | null;
const resetBtn = document.getElementById(
  'resetCoinsBtn',
) as HTMLButtonElement | null;
const coinButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.coin-button[data-coin-value]'),
);
function readCounters(): Counters {
  try {
    const raw = window.localStorage.getItem(COUNTERS_KEY);
    if (raw === null) return { ...ZERO_COUNTERS };
    const parsed = JSON.parse(raw) as Partial<Counters> | null;
    if (!parsed || typeof parsed !== 'object') return { ...ZERO_COUNTERS };
    return {
      one:
        typeof parsed.one === 'number' && Number.isFinite(parsed.one)
          ? parsed.one
          : 0,
      five:
        typeof parsed.five === 'number' && Number.isFinite(parsed.five)
          ? parsed.five
          : 0,
      ten:
        typeof parsed.ten === 'number' && Number.isFinite(parsed.ten)
          ? parsed.ten
          : 0,
      twenty:
        typeof parsed.twenty === 'number' && Number.isFinite(parsed.twenty)
          ? parsed.twenty
          : 0,
    };
  } catch {
    return { ...ZERO_COUNTERS };
  }
}

function writeCounters(c: Counters): void {
  window.localStorage.setItem(COUNTERS_KEY, JSON.stringify(c));
}

function incrementCounter(denom: Denomination): void {
  const current = readCounters();
  current[denom] += 1;
  writeCounters(current);
}

function resetCounters(): void {
  writeCounters({ ...ZERO_COUNTERS });
}

function renderCounters(): void {
  const counters = readCounters();
  for (const denom of Object.keys(
    COIN_VALUE_TO_DENOM,
  ) as unknown as Denomination[]) {
    const cell = document.querySelector<HTMLElement>(
      `[data-counter-count="${denom}"]`,
    );
    if (cell) cell.textContent = `× ${counters[denom]}`;
  }
}

async function refreshLiveBalance(): Promise<void> {
  if (!liveBalanceEl) return;
  try {
    const res = await apiFetch('/api/balance');
    if (!res.ok) {
      liveBalanceEl.textContent = '—';
      return;
    }
    const data = (await res.json()) as { balance?: number };
    const balance = typeof data.balance === 'number' ? data.balance : 0;
    liveBalanceEl.textContent = peso(balance);
  } catch {
    liveBalanceEl.textContent = '—';
  }
}

async function handleCoinClick(btn: HTMLButtonElement): Promise<void> {
  const value = Number.parseInt(btn.dataset.coinValue ?? '', 10);
  if (!Number.isFinite(value) || !(value in COIN_VALUE_TO_DENOM)) {
    setMessage('Invalid coin value. Accepted: 1, 5, 10, 20.');
    return;
  }

  const denom = COIN_VALUE_TO_DENOM[value];

  // Disable all buttons during the request to prevent double-fire.
  for (const b of coinButtons) b.disabled = true;

  try {
    const res = await apiFetch('/api/balance/add-test-coin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });

    if (res.ok) {
      setMessage('Simulated coin confirmed by the worker.');
      incrementCounter(denom);
      renderCounters();
      await refreshLiveBalance();
      return;
    }

    if (res.status === 400) {
      setMessage('Invalid coin value. Accepted: 1, 5, 10, 20.');
      return;
    }

    if (res.status === 409) {
      let reason = 'safety gate';
      try {
        const body = (await res.json()) as {
          reason?: string;
          details?: string;
        };
        if (body?.details) reason = body.details;
        else if (body?.reason) reason = body.reason;
      } catch {
        /* ignore body parse errors */
      }
      setMessage(`Coin rejected: ${reason}`);
      return;
    }

    if (res.status >= 500) {
      const body = await res.json().catch(() => ({})) as { details?: string };
      setMessage(body.details ?? 'Coin simulation failed. Check the worker and server logs.');
      await refreshLiveBalance();
      return;
    }

    // Any other status — treat as a transient error.
    setMessage(`Coin failed (HTTP ${res.status}). See server logs.`);
  } catch {
    setMessage('Failed to process test coin. See server logs.');
  } finally {
    for (const b of coinButtons) b.disabled = false;
  }
}

function bindCoinButtons(): void {
  for (const btn of coinButtons) {
    btn.addEventListener('click', () => {
      void handleCoinClick(btn);
    });
  }
}

declare const io:
  | ((opts?: {
      auth?: Record<string, string>;
      reconnectionDelay?: number;
    }) => {
      on(event: string, cb: (...args: unknown[]) => void): void;
      disconnect(): void;
    })
  | undefined;

let socket: { on(event: string, cb: (...args: unknown[]) => void): void } | null =
  null;

function connectSocket(): void {
  if (typeof io !== 'function' || socket) return;
  try {
    socket = io({ reconnectionDelay: 2000 });
    socket.on('balance', (balance: unknown) => {
      if (liveBalanceEl && typeof balance === 'number') {
        liveBalanceEl.textContent = peso(balance);
      }
    });
    socket.on('coinAccepted', (data: unknown) => {
      if (
        data &&
        typeof data === 'object' &&
        'balance' in data &&
        typeof (data as { balance: unknown }).balance === 'number'
      ) {
        if (liveBalanceEl) {
          liveBalanceEl.textContent = peso(
            (data as { balance: number }).balance,
          );
        }
      }
    });
  } catch {
    // Socket.IO optional enhancement
  }
}

async function handleReset(): Promise<void> {
  if (resetBtn) resetBtn.disabled = true;
  setMessage('Resetting coins and balance...');
  try {
    const res = await apiFetch('/api/admin/balance/reset', {
      method: 'POST',
    });
    if (!res.ok) {
      await apiFetch('/api/balance/reset', { method: 'POST' });
    }
    resetCounters();
    renderCounters();
    await refreshLiveBalance();
    setMessage('Coins and balance reset.');
  } catch {
    resetCounters();
    renderCounters();
    await refreshLiveBalance();
    setMessage('Counters reset.');
  } finally {
    if (resetBtn) resetBtn.disabled = false;
  }
}

function bindResetButton(): void {
  if (!resetBtn) return;
  resetBtn.addEventListener('click', () => {
    void handleReset();
  });
}

function showMain(): void {
  if (mainEl) mainEl.classList.remove('hidden');
  if (authViewEl) authViewEl.classList.add('hidden');
  renderCounters();
  void refreshLiveBalance();
  connectSocket();
}

let initialized = false;

function bootstrap(): void {
  initAuth({
    onSuccess: () => {
      showMain();
      if (!initialized) {
        bindCoinButtons();
        bindResetButton();
        initDirectPrint();
        initialized = true;
      }
    },
    formId: 'adminAuthForm',
    errorId: 'adminMessage',
    viewId: 'adminAuthView',
    mainId: 'coinConsoleMain',
  });
}

bootstrap();
