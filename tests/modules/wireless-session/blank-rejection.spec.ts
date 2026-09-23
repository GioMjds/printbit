describe('Wireless Session Blank Page Rejection', () => {
  it('correctly distinguishes 100% blank from mixed document handling', () => {
    const handleAnalysisResult = (analysis: {
      isEntirelyBlank?: boolean;
      blankPageCount?: number;
    }) => {
      if (analysis.isEntirelyBlank) {
        return {
          action: 'reject_and_delete',
          event: 'DocumentRejected',
          reason: 'ALL_PAGES_BLANK',
        };
      }
      return { action: 'persist_and_complete', event: 'AnalysisCompleted' };
    };

    expect(
      handleAnalysisResult({ isEntirelyBlank: true, blankPageCount: 1 }),
    ).toEqual({
      action: 'reject_and_delete',
      event: 'DocumentRejected',
      reason: 'ALL_PAGES_BLANK',
    });

    expect(
      handleAnalysisResult({ isEntirelyBlank: false, blankPageCount: 1 }),
    ).toEqual({
      action: 'persist_and_complete',
      event: 'AnalysisCompleted',
    });
  });

  it('constructs correct DocumentRejected event payload for blank documents', () => {
    const buildRejectionPayload = (
      sessionId: string,
      documentId: string,
      filename: string,
    ) => ({
      sessionId,
      documentId,
      filename,
      reason: 'ALL_PAGES_BLANK' as const,
      message:
        'All pages in this file are blank. Blank documents cannot be sent to the kiosk.',
    });

    const payload = buildRejectionPayload('sess-1', 'doc-1', 'blank.pdf');
    expect(payload).toEqual({
      sessionId: 'sess-1',
      documentId: 'doc-1',
      filename: 'blank.pdf',
      reason: 'ALL_PAGES_BLANK',
      message:
        'All pages in this file are blank. Blank documents cannot be sent to the kiosk.',
    });
  });

  it('constructs correct admin audit log payload for blank document rejection', () => {
    const buildAdminLog = (
      sessionId: string,
      documentId: string,
      filename: string,
      pageCount: number,
    ) => ({
      type: 'document_rejected_blank',
      message: `Document ${filename} rejected: all pages are blank.`,
      meta: {
        sessionId,
        documentId,
        filename,
        pageCount,
      },
    });

    const log = buildAdminLog('sess-1', 'doc-1', 'empty.pdf', 5);
    expect(log).toEqual({
      type: 'document_rejected_blank',
      message: 'Document empty.pdf rejected: all pages are blank.',
      meta: {
        sessionId: 'sess-1',
        documentId: 'doc-1',
        filename: 'empty.pdf',
        pageCount: 5,
      },
    });
  });

  it('handles lifecycle decision: rejects when isEntirelyBlank is true, preserves when false or undefined', () => {
    const lifecycleDecider = (analysis: {
      isEntirelyBlank?: boolean;
      blankPages?: number[];
      totalPages?: number;
    }) => {
      if (analysis.isEntirelyBlank) {
        return {
          purgeFromSessionStore: true,
          unlinkPhysicalFiles: true,
          appendAdminLog: true,
          emitEvent: 'DocumentRejected',
          stopProcessing: true,
        };
      }
      return {
        purgeFromSessionStore: false,
        unlinkPhysicalFiles: false,
        appendAdminLog: false,
        emitEvent: 'AnalysisCompleted',
        stopProcessing: false,
      };
    };

    // 100% blank document
    expect(
      lifecycleDecider({
        isEntirelyBlank: true,
        blankPages: [1, 2],
        totalPages: 2,
      }),
    ).toEqual({
      purgeFromSessionStore: true,
      unlinkPhysicalFiles: true,
      appendAdminLog: true,
      emitEvent: 'DocumentRejected',
      stopProcessing: true,
    });

    // Mixed document with 1 blank page out of 3
    expect(
      lifecycleDecider({
        isEntirelyBlank: false,
        blankPages: [2],
        totalPages: 3,
      }),
    ).toEqual({
      purgeFromSessionStore: false,
      unlinkPhysicalFiles: false,
      appendAdminLog: false,
      emitEvent: 'AnalysisCompleted',
      stopProcessing: false,
    });

    // Document with no blank pages
    expect(
      lifecycleDecider({
        isEntirelyBlank: false,
        blankPages: [],
        totalPages: 1,
      }),
    ).toEqual({
      purgeFromSessionStore: false,
      unlinkPhysicalFiles: false,
      appendAdminLog: false,
      emitEvent: 'AnalysisCompleted',
      stopProcessing: false,
    });
  });
});
