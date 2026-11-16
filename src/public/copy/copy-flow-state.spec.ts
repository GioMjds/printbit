import {
  canContinue,
  createCopyFlowState,
  isCopyTypeLocked,
  isSheetComplete,
  nextIdScanTarget,
  parseSnapshot,
  reduceCopyFlow,
  toSnapshot,
  type CopyFlowEvent,
  type CopyFlowState,
} from './copy-flow-state';

function run(
  events: CopyFlowEvent[],
  start = createCopyFlowState(),
): CopyFlowState {
  return events.reduce(reduceCopyFlow, start);
}

const scanFront: CopyFlowEvent[] = [
  { type: 'copy-type-selected', copyType: 'id' },
  { type: 'scan-started', target: 'front' },
  { type: 'side-scanned', side: 'front', warnings: [] },
];
const scanBoth: CopyFlowEvent[] = [
  ...scanFront,
  { type: 'scan-started', target: 'back' },
  { type: 'side-scanned', side: 'back', warnings: [] },
];

describe('document copy', () => {
  it('starts in capture with nothing scanned', () => {
    const state = createCopyFlowState();
    expect(state.copyType).toBe('document');
    expect(state.stage).toBe('capture');
    expect(canContinue(state)).toBe(false);
    expect(isCopyTypeLocked(state)).toBe(false);
  });

  it('moves to settings after the scan', () => {
    const state = run([
      { type: 'scan-started', target: 'document' },
      { type: 'document-scanned' },
    ]);
    expect(state.stage).toBe('settings');
    expect(isSheetComplete(state)).toBe(true);
    expect(canContinue(state)).toBe(true);
    expect(isCopyTypeLocked(state)).toBe(true);
  });

  it('stays in capture when the scan fails', () => {
    const state = run([
      { type: 'scan-started', target: 'document' },
      { type: 'scan-failed' },
    ]);
    expect(state.stage).toBe('capture');
    expect(state.scanning).toBeNull();
    expect(isCopyTypeLocked(state)).toBe(false);
  });
});

describe('ID card copy', () => {
  it('asks for the front, then the back', () => {
    const start = run([{ type: 'copy-type-selected', copyType: 'id' }]);
    expect(nextIdScanTarget(start)).toBe('front');
    const afterFront = run(scanFront);
    expect(nextIdScanTarget(afterFront)).toBe('back');
    expect(afterFront.stage).toBe('capture');
    expect(canContinue(afterFront)).toBe(false);
  });

  it('moves to settings only when both sides are scanned', () => {
    const state = run(scanBoth);
    expect(state.stage).toBe('settings');
    expect(nextIdScanTarget(state)).toBeNull();
    expect(canContinue(state)).toBe(true);
  });

  it('holds in capture while a warning is unanswered, then moves on Keep', () => {
    const warned = run([
      ...scanFront,
      { type: 'scan-started', target: 'back' },
      {
        type: 'side-scanned',
        side: 'back',
        warnings: [{ code: 'sides_identical', side: 'back' }],
      },
    ]);
    expect(warned.stage).toBe('capture');
    expect(canContinue(warned)).toBe(false);
    const kept = reduceCopyFlow(warned, { type: 'warning-kept' });
    expect(kept.pendingWarnings).toEqual([]);
    expect(kept.stage).toBe('settings');
    expect(canContinue(kept)).toBe(true);
  });

  it('clears the warning on Retake and keeps the side until the rescan', () => {
    const warned = run([
      ...scanFront.slice(0, 2),
      {
        type: 'side-scanned',
        side: 'front',
        warnings: [{ code: 'side_blank', side: 'front' }],
      },
    ]);
    const retake = reduceCopyFlow(warned, { type: 'warning-retake' });
    expect(retake.pendingWarnings).toEqual([]);
    expect(retake.front).toBe(true);
    expect(retake.stage).toBe('capture');
  });

  it('stays in settings during a retake and blocks Continue while it runs', () => {
    const retaking = run([
      ...scanBoth,
      { type: 'scan-started', target: 'front' },
    ]);
    expect(retaking.stage).toBe('settings');
    expect(canContinue(retaking)).toBe(false);
    const done = reduceCopyFlow(retaking, {
      type: 'side-scanned',
      side: 'front',
      warnings: [],
    });
    expect(done.stage).toBe('settings');
    expect(canContinue(done)).toBe(true);
  });

  it('blocks Continue in settings when a retake raises a warning', () => {
    const state = run([
      ...scanBoth,
      { type: 'scan-started', target: 'back' },
      {
        type: 'side-scanned',
        side: 'back',
        warnings: [{ code: 'side_blank', side: 'back' }],
      },
    ]);
    expect(state.stage).toBe('settings');
    expect(canContinue(state)).toBe(false);
  });

  it('rotates a scanned side by quarter turns and resets it on a retake', () => {
    let state = run(scanBoth);
    state = reduceCopyFlow(state, { type: 'side-rotated', side: 'front' });
    state = reduceCopyFlow(state, { type: 'side-rotated', side: 'front' });
    state = reduceCopyFlow(state, { type: 'side-rotated', side: 'back' });
    expect(state.rotations).toEqual({ front: 180, back: 90 });
    state = run(
      [
        { type: 'scan-started', target: 'front' },
        { type: 'side-scanned', side: 'front', warnings: [] },
      ],
      state,
    );
    expect(state.rotations).toEqual({ front: 0, back: 90 });
  });

  it('wraps a rotation back to 0 after four turns', () => {
    let state = run(scanFront);
    for (let i = 0; i < 4; i += 1) {
      state = reduceCopyFlow(state, { type: 'side-rotated', side: 'front' });
    }
    expect(state.rotations.front).toBe(0);
  });

  it('ignores a rotation for a side that is not scanned', () => {
    const state = reduceCopyFlow(run(scanFront), {
      type: 'side-rotated',
      side: 'back',
    });
    expect(state.rotations.back).toBe(0);
  });
});

describe('guards', () => {
  it('ignores a second scan while one is running', () => {
    const state = run([
      { type: 'copy-type-selected', copyType: 'id' },
      { type: 'scan-started', target: 'front' },
      { type: 'scan-started', target: 'back' },
    ]);
    expect(state.scanning).toBe('front');
  });

  it('ignores a scan target that does not match the copy type', () => {
    const state = run([{ type: 'scan-started', target: 'front' }]);
    expect(state.scanning).toBeNull();
  });

  it('locks the copy type once a scan exists or is running', () => {
    const scanning = run([{ type: 'scan-started', target: 'document' }]);
    expect(isCopyTypeLocked(scanning)).toBe(true);
    const changed = reduceCopyFlow(scanning, {
      type: 'copy-type-selected',
      copyType: 'id',
    });
    expect(changed.copyType).toBe('document');
  });

  it('start over clears every scan, returns to capture and keeps the type', () => {
    const state = reduceCopyFlow(run(scanBoth), { type: 'start-over' });
    expect(state).toEqual(createCopyFlowState('id'));
    expect(isCopyTypeLocked(state)).toBe(false);
  });
});

describe('snapshot', () => {
  it('restores the stage, sides and rotations', () => {
    const before = reduceCopyFlow(run(scanBoth), {
      type: 'side-rotated',
      side: 'back',
    });
    const raw = JSON.stringify(toSnapshot(before));
    const snapshot = parseSnapshot(raw)!;
    const after = reduceCopyFlow(createCopyFlowState(), {
      type: 'restored',
      snapshot,
    });
    expect(after).toEqual(before);
  });

  it('never restores a running scan or an open warning', () => {
    const warned = run([
      ...scanFront.slice(0, 2),
      {
        type: 'side-scanned',
        side: 'front',
        warnings: [{ code: 'side_blank', side: 'front' }],
      },
    ]);
    const snapshot = parseSnapshot(JSON.stringify(toSnapshot(warned)))!;
    const after = reduceCopyFlow(createCopyFlowState(), {
      type: 'restored',
      snapshot,
    });
    expect(after.pendingWarnings).toEqual([]);
    expect(after.scanning).toBeNull();
  });

  it('restores an incomplete ID capture into the capture stage', () => {
    const snapshot = parseSnapshot(
      JSON.stringify({
        copyType: 'id',
        stage: 'settings',
        documentScanned: false,
        front: true,
        back: false,
        rotations: { front: 0, back: 0 },
      }),
    )!;
    const after = reduceCopyFlow(createCopyFlowState(), {
      type: 'restored',
      snapshot,
    });
    expect(after.stage).toBe('capture');
  });

  it.each([
    null,
    '',
    'not json',
    '{}',
    '{"copyType":"fax"}',
    '{"copyType":"id","rotations":{"front":45}}',
  ])('rejects %p', (raw) => {
    expect(parseSnapshot(raw)).toBeNull();
  });
});
