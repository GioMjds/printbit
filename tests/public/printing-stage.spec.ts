import {
  getExpectedPrintPages,
  getMonotonicPrintedPages,
  getPrintingStage,
} from '../../src/public/confirm/printing-stage';

describe('printing stage', () => {
  test('shows a useful stage before page telemetry arrives', () => {
    expect(getPrintingStage({ pagesPrinted: 0, totalPages: null })).toEqual({
      label: 'Preparing your print job…',
      progress: null,
    });
  });

  test('shows the current printed page when telemetry arrives', () => {
    expect(getPrintingStage({ pagesPrinted: 2, totalPages: 5 })).toEqual({
      label: 'Printing page 2 of 5',
      progress: 40,
    });
  });

  test('clamps delayed worker telemetry to the known total', () => {
    expect(getPrintingStage({ pagesPrinted: 5, totalPages: 4 })).toEqual({
      label: 'Printing page 4 of 4',
      progress: 100,
    });
  });

  test('does not regress when delayed persisted telemetry follows a raw update', () => {
    expect(
      getMonotonicPrintedPages({
        displayedPages: 2,
        incomingPages: 1,
        totalPages: 4,
      }),
    ).toBe(2);
  });

  test('shows zero progress when the print total is known before telemetry arrives', () => {
    expect(getPrintingStage({ pagesPrinted: 0, totalPages: 30 })).toEqual({
      label: 'Preparing your print job…',
      progress: 0,
    });
  });

  test('counts every selected page in every copy', () => {
    expect(getExpectedPrintPages({ selectedPages: 10, copies: 3 })).toBe(30);
  });

  test('falls back safely when stored print configuration is invalid', () => {
    expect(
      getExpectedPrintPages({ selectedPages: Number.NaN, copies: 3 }),
    ).toBe(3);
    expect(
      getExpectedPrintPages({ selectedPages: 10, copies: Number.POSITIVE_INFINITY }),
    ).toBe(10);
  });
});
