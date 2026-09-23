export type SupportedLanguage = 'en' | 'fil';

interface LanguageApiResponse {
  language: SupportedLanguage;
  languages: { code: SupportedLanguage; label: string }[];
  highContrast: boolean;
  translations: Record<string, string>;
}

const STORAGE_LANGUAGE_KEY = 'printbit.kiosk.language';
const STORAGE_CONTRAST_KEY = 'printbit.kiosk.highContrast';
export const KIOSK_LANGUAGE_CHANGED_EVENT = 'printbit:language-changed';

let currentLanguage: SupportedLanguage = 'en';
let currentTranslations: Record<string, string> = {};
let initialized = false;
let observer: MutationObserver | null = null;
let flushHandle: number | null = null;

const originalTextNodes = new WeakMap<Text, string>();
const internallyUpdatedTextNodes = new WeakSet<Text>();
const originalAttributes = new WeakMap<Element, Map<string, string>>();
const queuedElementRoots = new Set<Element>();
const CONTROL_SELECTOR =
  'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"]';
const HOMEPAGE_ROUTE = '/';
const translatableAttributes = [
  'aria-label',
  'title',
  'placeholder',
  'aria-description',
] as const;

function getStoredLanguage(): SupportedLanguage {
  const raw = window.localStorage.getItem(STORAGE_LANGUAGE_KEY);
  return raw === 'fil' ? 'fil' : 'en';
}

function getStoredContrast(): boolean {
  return window.localStorage.getItem(STORAGE_CONTRAST_KEY) === 'true';
}

function translatePhrase(text: string): string {
  if (!text.trim()) return text;
  return currentTranslations[text] ?? text;
}

function applyTextNodeTranslation(node: Text): void {
  const current = node.nodeValue ?? '';
  if (!originalTextNodes.has(node)) {
    originalTextNodes.set(node, current);
  }
  const source = originalTextNodes.get(node) ?? current;
  const trimmed = source.trim();
  if (!trimmed) return;

  const translated = translatePhrase(trimmed);
  let nextValue = source;
  if (translated !== trimmed) {
    const start = source.indexOf(trimmed);
    if (start < 0) {
      nextValue = translated;
    } else {
      const end = start + trimmed.length;
      nextValue = `${source.slice(0, start)}${translated}${source.slice(end)}`;
    }
  }

  if (current !== nextValue) {
    internallyUpdatedTextNodes.add(node);
    node.nodeValue = nextValue;
  }
}

function applyAttributeTranslation(el: Element): void {
  let snapshot = originalAttributes.get(el);
  if (!snapshot) {
    snapshot = new Map<string, string>();
    originalAttributes.set(el, snapshot);
  }

  for (const attr of translatableAttributes) {
    const live = el.getAttribute(attr);
    if (live === null) continue;
    if (!snapshot.has(attr)) {
      snapshot.set(attr, live);
    }
    const source = snapshot.get(attr) ?? live;
    const translated = translatePhrase(source);
    if (live !== translated) {
      el.setAttribute(attr, translated);
    }
  }
}

function localizeTree(root: ParentNode): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parentName = node.parentElement?.tagName.toLowerCase() ?? '';
      if (
        parentName === 'script' ||
        parentName === 'style' ||
        parentName === 'noscript'
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let current = walker.nextNode();
  while (current) {
    applyTextNodeTranslation(current as Text);
    current = walker.nextNode();
  }

  const elements = (root as Element).querySelectorAll
    ? (root as Element).querySelectorAll('*')
    : [];
  elements.forEach((el) => {
    applyAttributeTranslation(el);
  });
}

function ensureAriaLabels(root: ParentNode = document): void {
  const controls: HTMLElement[] = [];
  if (root instanceof HTMLElement && root.matches(CONTROL_SELECTOR)) {
    controls.push(root);
  }
  if ('querySelectorAll' in root) {
    controls.push(
      ...Array.from(root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)),
    );
  }

  for (const el of controls) {
    if (el.hasAttribute('aria-label')) continue;
    const title = el.getAttribute('title')?.trim() ?? '';
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const label = title || text;
    if (label) {
      if (el.getAttribute('aria-label') !== label) {
        el.setAttribute('aria-label', label);
      }
    }
  }
}

function applyHighContrast(enabled: boolean): void {
  document.documentElement.setAttribute(
    'data-high-contrast',
    enabled ? 'true' : 'false',
  );
  window.localStorage.setItem(STORAGE_CONTRAST_KEY, String(enabled));
}

async function loadLanguagePayload(): Promise<void> {
  const response = await fetch('/api/language');
  if (!response.ok) {
    throw new Error('Failed to load language preferences.');
  }
  const payload = (await response.json()) as LanguageApiResponse;
  currentLanguage = payload.language;
  currentTranslations = payload.translations;
  document.documentElement.lang = currentLanguage;
  window.localStorage.setItem(STORAGE_LANGUAGE_KEY, currentLanguage);
  applyHighContrast(payload.highContrast);
}

function flushQueuedLocalization(): void {
  flushHandle = null;
  if (queuedElementRoots.size === 0) return;

  const roots = Array.from(queuedElementRoots);
  queuedElementRoots.clear();
  for (const root of roots) {
    localizeTree(root);
    ensureAriaLabels(root);
  }
}

function queueLocalizationForElement(root: Element): void {
  queuedElementRoots.add(root);
  if (flushHandle !== null) return;
  flushHandle = window.requestAnimationFrame(flushQueuedLocalization);
}

function setupMutationObserver(): void {
  if (observer || !document.body) return;
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        const target = mutation.target as Text;
        if (internallyUpdatedTextNodes.has(target)) {
          internallyUpdatedTextNodes.delete(target);
          continue;
        }
        originalTextNodes.set(target, target.nodeValue ?? '');
        applyTextNodeTranslation(target);
        continue;
      }

      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          applyTextNodeTranslation(node as Text);
          return;
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
          queueLocalizationForElement(node as Element);
        }
      });
    }
  });

  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
}

async function setLanguage(language: SupportedLanguage): Promise<void> {
  if (language !== 'en' && language !== 'fil') return;
  const response = await fetch('/api/language', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language }),
  });
  if (!response.ok) {
    throw new Error('Failed to save language preference.');
  }
  await loadLanguagePayload();
  localizeTree(document.body);
  ensureAriaLabels(document.body);
  updateControlBarState();
  window.dispatchEvent(
    new CustomEvent(KIOSK_LANGUAGE_CHANGED_EVENT, {
      detail: { language: currentLanguage },
    }),
  );
}

function updateControlBarState(): void {
  const bar = document.getElementById('printbitLanguageFab');
  if (!bar) return;
  const trigger = bar.querySelector<HTMLButtonElement>(
    '[data-role="language-toggle"]',
  );
  const languageBadge = bar.querySelector<HTMLElement>(
    '[data-role="language-badge"]',
  );

  if (languageBadge) {
    languageBadge.textContent = currentLanguage.toUpperCase();
  }
  trigger?.setAttribute(
    'aria-label',
    currentLanguage === 'fil'
      ? 'Language toggle. Current language: Filipino. Click to switch to English.'
      : 'Language toggle. Current language: English. Click to switch to Filipino.',
  );
}

function ensureControlBar(): void {
  if (window.location.pathname !== HOMEPAGE_ROUTE) return;
  if (document.getElementById('printbitLanguageFab') || !document.body) return;
  const bar = document.createElement('section');
  bar.className = 'printbit-language-fab';
  bar.id = 'printbitLanguageFab';
  bar.setAttribute('aria-label', 'Language controls');
  bar.innerHTML = `
    <button
      type="button"
      class="printbit-language-fab__trigger"
      data-role="language-toggle"
      aria-label="Language toggle"
      title="Language toggle"
    >
      <span aria-hidden="true">🌐</span>
      <span class="printbit-language-fab__badge" data-role="language-badge">EN</span>
    </button>
  `;
  document.body.appendChild(bar);

  const trigger = bar.querySelector<HTMLButtonElement>(
    '[data-role="language-toggle"]',
  );
  trigger?.addEventListener('click', () => {
    const nextLanguage: SupportedLanguage =
      currentLanguage === 'en' ? 'fil' : 'en';
    void setLanguage(nextLanguage).catch((error: unknown) => {
      console.error('[i18n] Failed to toggle language.', error);
    });
  });
}

export function translation(key: string, fallback?: string): string {
  return currentTranslations[key] ?? fallback ?? key;
}

export async function initKioskLocalization(): Promise<void> {
  if (initialized) return;
  initialized = true;

  try {
    await loadLanguagePayload();
  } catch (error) {
    console.error('[i18n] Failed to load language payload from server.', error);
    currentLanguage = getStoredLanguage();
    currentTranslations = {};
    document.documentElement.lang = currentLanguage;
    applyHighContrast(getStoredContrast());
  }

  ensureControlBar();
  localizeTree(document.body);
  ensureAriaLabels(document.body);
  setupMutationObserver();
  updateControlBarState();
}
