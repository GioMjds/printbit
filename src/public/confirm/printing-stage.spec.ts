import { getPrintingStage } from './printing-stage';

describe('getPrintingStage', () => {
  it('words print progress as before', () => {
    expect(getPrintingStage({ pagesPrinted: 2, totalPages: 5 })).toEqual({
      label: 'Printing page 2 of 5',
      progress: 40,
    });
  });

  it('words copy progress like the printer panel', () => {
    expect(
      getPrintingStage({ pagesPrinted: 2, totalPages: 5, mode: 'copy' }),
    ).toEqual({ label: 'Copying 2/5', progress: 40 });
  });

  it('never counts past the total', () => {
    expect(
      getPrintingStage({ pagesPrinted: 7, totalPages: 5, mode: 'copy' }).label,
    ).toBe('Copying 5/5');
  });

  it('prepares before the first copy page', () => {
    expect(
      getPrintingStage({ pagesPrinted: 0, totalPages: 5, mode: 'copy' }),
    ).toEqual({ label: 'Preparing your print job…', progress: 0 });
  });

  it('prepares while the total is unknown', () => {
    expect(
      getPrintingStage({ pagesPrinted: 3, totalPages: null, mode: 'copy' }),
    ).toEqual({ label: 'Preparing your print job…', progress: null });
  });
});
