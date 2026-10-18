/**
 * @jest-environment jsdom
 */
import {
  BlankPageWarningModal,
  computeNonBlankRanges,
} from './blank-page-modal';

describe('computeNonBlankRanges', () => {
  it('returns empty array when all selected pages are blank', () => {
    expect(computeNonBlankRanges([1, 2, 3], [1, 2, 3])).toEqual([]);
  });

  it('excludes single middle blank page from sequential pages', () => {
    const result = computeNonBlankRanges([1, 2, 3, 4, 5], [3]);
    expect(result).toEqual([
      { start: 1, end: 2 },
      { start: 4, end: 5 },
    ]);
  });

  it('excludes multiple blank pages correctly', () => {
    const result = computeNonBlankRanges([1, 2, 3, 4, 5, 6], [2, 4]);
    expect(result).toEqual([
      { start: 1, end: 1 },
      { start: 3, end: 3 },
      { start: 5, end: 6 },
    ]);
  });

  it('handles first page blank', () => {
    const result = computeNonBlankRanges([1, 2, 3], [1]);
    expect(result).toEqual([{ start: 2, end: 3 }]);
  });

  it('handles last page blank', () => {
    const result = computeNonBlankRanges([1, 2, 3], [3]);
    expect(result).toEqual([{ start: 1, end: 2 }]);
  });

  it('handles custom disjoint selections', () => {
    const result = computeNonBlankRanges([1, 3, 5, 7, 9], [3, 7]);
    expect(result).toEqual([
      { start: 1, end: 1 },
      { start: 5, end: 5 },
      { start: 9, end: 9 },
    ]);
  });
});

describe('BlankPageWarningModal', () => {
  let dialog: HTMLDialogElement;
  let onExcludeMock: jest.Mock;
  let onKeepMock: jest.Mock;
  let onPreviewPageMock: jest.Mock;
  let modal: BlankPageWarningModal;

  beforeEach(() => {
    dialog = document.createElement('dialog');
    dialog.id = 'blankPageWarningDialog';
    dialog.innerHTML = `
      <div class="blank-warning-content">
        <h2 id="blankWarningTitle">Blank Pages Detected</h2>
        <button id="blankWarningCloseBtn" type="button"></button>
        <div id="blankWarningPagesList"></div>
        <button id="blankWarningExcludeBtn" type="button"><span>Exclude Blank Pages & Continue</span></button>
        <button id="blankWarningKeepBtn" type="button"><span>Print Blank Pages Anyway</span></button>
        <button id="blankWarningAdjustBtn" type="button"><span>Adjust Selection on Config</span></button>
      </div>
    `;
    document.body.appendChild(dialog);

    // Mock HTMLDialogElement methods in jsdom if missing
    if (!dialog.showModal) {
      dialog.showModal = function () {
        this.setAttribute('open', '');
      };
    }
    if (!dialog.close) {
      dialog.close = function () {
        this.removeAttribute('open');
      };
    }

    onExcludeMock = jest.fn().mockResolvedValue(undefined);
    onKeepMock = jest.fn();
    onPreviewPageMock = jest.fn();

    modal = new BlankPageWarningModal({
      dialog,
      onExclude: onExcludeMock,
      onKeep: onKeepMock,
      onPreviewPage: onPreviewPageMock,
    });
  });

  afterEach(() => {
    dialog.remove();
    jest.clearAllMocks();
  });

  it('opens and renders blank page pills', () => {
    modal.open([1, 2, 3, 4], [2, 4]);

    expect(modal.isVisible()).toBe(true);
    const pills = dialog.querySelectorAll('.blank-warning-page-pill');
    expect(pills.length).toBe(2);
    expect(pills[0].textContent).toContain('Page 2');
    expect(pills[1].textContent).toContain('Page 4');
  });

  it('calls onPreviewPage and closes when pill is clicked', () => {
    modal.open([1, 2, 3], [2]);
    const pill = dialog.querySelector<HTMLButtonElement>('.blank-warning-page-pill');
    pill?.click();

    expect(onPreviewPageMock).toHaveBeenCalledWith(2);
    expect(modal.isVisible()).toBe(false);
  });

  it('calls onKeep and closes when keep button is clicked', () => {
    modal.open([1, 2, 3], [2]);
    const keepBtn = dialog.querySelector<HTMLButtonElement>('#blankWarningKeepBtn');
    keepBtn?.click();

    expect(onKeepMock).toHaveBeenCalled();
    expect(modal.isVisible()).toBe(false);
  });

  it('calls onExclude with non-blank ranges when exclude button is clicked', async () => {
    modal.open([1, 2, 3, 4, 5], [3]);
    const excludeBtn = dialog.querySelector<HTMLButtonElement>('#blankWarningExcludeBtn');
    excludeBtn?.click();

    // Wait for promise resolution
    await Promise.resolve();

    expect(onExcludeMock).toHaveBeenCalledWith([
      { start: 1, end: 2 },
      { start: 4, end: 5 },
    ]);
    expect(modal.isVisible()).toBe(false);
  });

  it('closes without action when adjust or close button is clicked', () => {
    modal.open([1, 2, 3], [2]);
    const closeBtn = dialog.querySelector<HTMLButtonElement>('#blankWarningCloseBtn');
    closeBtn?.click();

    expect(onExcludeMock).not.toHaveBeenCalled();
    expect(onKeepMock).not.toHaveBeenCalled();
    expect(modal.isVisible()).toBe(false);
  });
});
