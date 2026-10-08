import {
  calculateSuggestedRefund,
  calculatePriorRefunds,
  calculateMaxRefundable,
} from '../../src/public/admin/transactions/refund-calculator';

describe('calculateSuggestedRefund', () => {
  describe('K < N: pro-rated refund rounding', () => {
    it('calculates correct pro-rated refund for 3 requested, 1 printed, 10 charged -> 6.67', () => {
      // (3 - 1) / 3 * 10 = 2/3 * 10 = 6.6666... -> 6.67
      expect(calculateSuggestedRefund(3, 1, 10)).toBe(6.67);
    });

    it('calculates correct pro-rated refund when 0 pages printed (full refund)', () => {
      // (4 - 0) / 4 * 20 = 20.00
      expect(calculateSuggestedRefund(4, 0, 20)).toBe(20);
    });

    it('calculates exact pro-rated refund for clean multiples', () => {
      // (5 - 2) / 5 * 15 = 3/5 * 15 = 9.00
      expect(calculateSuggestedRefund(5, 2, 15)).toBe(9);
      // (10 - 9) / 10 * 20 = 1/10 * 20 = 2.00
      expect(calculateSuggestedRefund(10, 9, 20)).toBe(2);
    });
  });

  describe('K >= N: returns 0', () => {
    it('returns 0 when printed equals requested (K = N)', () => {
      expect(calculateSuggestedRefund(3, 3, 10)).toBe(0);
      expect(calculateSuggestedRefund(1, 1, 5)).toBe(0);
      expect(calculateSuggestedRefund(100, 100, 250)).toBe(0);
    });

    it('returns 0 when printed exceeds requested (K > N)', () => {
      expect(calculateSuggestedRefund(3, 4, 10)).toBe(0);
      expect(calculateSuggestedRefund(5, 10, 25)).toBe(0);
    });
  });

  describe('N <= 0 or charged <= 0: returns 0', () => {
    it('returns 0 when requested pages is 0 or negative', () => {
      expect(calculateSuggestedRefund(0, 0, 10)).toBe(0);
      expect(calculateSuggestedRefund(-1, 0, 10)).toBe(0);
      expect(calculateSuggestedRefund(-5, -2, 10)).toBe(0);
    });

    it('returns 0 when charged amount is 0 or negative', () => {
      expect(calculateSuggestedRefund(5, 2, 0)).toBe(0);
      expect(calculateSuggestedRefund(5, 2, -10)).toBe(0);
      expect(calculateSuggestedRefund(3, 0, 0)).toBe(0);
    });

    it('returns 0 for non-finite values', () => {
      expect(calculateSuggestedRefund(Number.NaN, 1, 10)).toBe(0);
      expect(calculateSuggestedRefund(5, 1, Number.NaN)).toBe(0);
      expect(calculateSuggestedRefund(Number.POSITIVE_INFINITY, 1, 10)).toBe(0);
      expect(calculateSuggestedRefund(5, 1, Number.POSITIVE_INFINITY)).toBe(0);
    });
  });

  describe('K < 0: clamped to 0', () => {
    it('clamps negative printed count to 0 and suggests full charged amount', () => {
      // Clamped to 0: (5 - 0) / 5 * 10 = 10.00
      expect(calculateSuggestedRefund(5, -1, 10)).toBe(10);
      expect(calculateSuggestedRefund(4, -50, 8.5)).toBe(8.5);
    });

    it('handles non-finite printed pages by treating as 0', () => {
      expect(calculateSuggestedRefund(4, Number.NaN, 20)).toBe(20);
    });
  });

  describe('Fractional centavos precision', () => {
    it('rounds to 2 decimal places (centavos precision)', () => {
      // (7 - 2) / 7 * 10 = 5/7 * 10 = 7.142857... -> 7.14
      expect(calculateSuggestedRefund(7, 2, 10)).toBe(7.14);

      // (3 - 2) / 3 * 5.50 = 1/3 * 5.50 = 1.833333... -> 1.83
      expect(calculateSuggestedRefund(3, 2, 5.5)).toBe(1.83);

      // (6 - 1) / 6 * 11.15 = 5/6 * 11.15 = 9.291666... -> 9.29
      expect(calculateSuggestedRefund(6, 1, 11.15)).toBe(9.29);

      // (3 - 1) / 3 * 1.00 = 2/3 * 1.00 = 0.666666... -> 0.67
      expect(calculateSuggestedRefund(3, 1, 1)).toBe(0.67);
    });

    it('handles half-centavo rounding correctly', () => {
      // (8 - 7) / 8 * 10 = 1/8 * 10 = 1.25 -> 1.25
      expect(calculateSuggestedRefund(8, 7, 10)).toBe(1.25);

      // (8 - 5) / 8 * 10 = 3/8 * 10 = 3.75 -> 3.75
      expect(calculateSuggestedRefund(8, 5, 10)).toBe(3.75);
    });
  });
});

describe('calculatePriorRefunds', () => {
  it('returns 0 when there are no ledger entries or pending refunds', () => {
    expect(calculatePriorRefunds([], [])).toBe(0);
    expect(calculatePriorRefunds(undefined, undefined)).toBe(0);
  });

  it('sums refund_issued ledger entries', () => {
    const ledger = [
      { eventType: 'refund_issued', amount: 5.5 },
      { eventType: 'job_completed', amount: 20 },
      { eventType: 'refund_issued', amount: 2.25 },
    ];
    expect(calculatePriorRefunds(ledger, [])).toBe(7.75);
  });

  it('includes refunded pendingRefunds if not referenced in ledger', () => {
    const pendingRefunds = [
      { id: 'pr-1', status: 'refunded', chargedAmount: 10 },
      { id: 'pr-2', status: 'open', chargedAmount: 5 },
      { id: 'pr-3', status: 'dismissed', chargedAmount: 8 },
    ];
    expect(calculatePriorRefunds([], pendingRefunds)).toBe(10);
  });

  it('avoids double-counting when pending refund id is referenced in ledger', () => {
    const ledger = [
      { eventType: 'refund_issued', amount: 10, referenceId: 'pr-1' },
    ];
    const pendingRefunds = [
      { id: 'pr-1', status: 'refunded', chargedAmount: 10 },
    ];
    expect(calculatePriorRefunds(ledger, pendingRefunds)).toBe(10);
  });

  it('avoids double-counting when transactionId is referenced in ledger', () => {
    const txId = 'tx-test-123';
    const ledger = [
      { eventType: 'refund_issued', amount: 15, referenceId: txId },
    ];
    const pendingRefunds = [
      { id: 'pr-1', status: 'refunded', chargedAmount: 15 },
    ];
    expect(calculatePriorRefunds(ledger, pendingRefunds, txId)).toBe(15);
  });
});

describe('calculateMaxRefundable', () => {
  it('returns 0 when chargedAmount is null, 0, or negative', () => {
    expect(calculateMaxRefundable(null)).toBe(0);
    expect(calculateMaxRefundable(0)).toBe(0);
    expect(calculateMaxRefundable(-10)).toBe(0);
    expect(calculateMaxRefundable(Number.NaN)).toBe(0);
  });

  it('returns full chargedAmount when no prior refunds exist', () => {
    expect(calculateMaxRefundable(25.5, [], [])).toBe(25.5);
  });

  it('deducts prior refunds from chargedAmount', () => {
    const ledger = [
      { eventType: 'refund_issued', amount: 10.25 },
    ];
    expect(calculateMaxRefundable(30, ledger, [])).toBe(19.75);
  });

  it('clamps to 0 when prior refunds meet or exceed charged amount', () => {
    const ledger = [
      { eventType: 'refund_issued', amount: 20 },
    ];
    expect(calculateMaxRefundable(20, ledger, [])).toBe(0);
    expect(calculateMaxRefundable(15, ledger, [])).toBe(0);
  });
});

