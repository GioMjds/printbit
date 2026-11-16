/**
 * Pure state of the /copy page. No DOM, no fetch, no timers.
 * app.ts holds one value of this and renders from it.
 */
import type { IdRotation, IdSide } from '../../shared/id-card-layout';
import type { IdScanWarning } from '../../shared/id-copy-contract';

export type CopyType = 'document' | 'id';
/** capture: choosing and scanning. settings: print settings and Continue. */
export type CopyStage = 'capture' | 'settings';
export type ScanTarget = 'document' | IdSide;

export interface CopyFlowState {
  copyType: CopyType;
  stage: CopyStage;
  documentScanned: boolean;
  front: boolean;
  back: boolean;
  rotations: Record<IdSide, IdRotation>;
  /** Warnings the customer has not answered yet. The first one is shown. */
  pendingWarnings: IdScanWarning[];
  scanning: ScanTarget | null;
}

export interface CopyFlowSnapshot {
  copyType: CopyType;
  stage: CopyStage;
  documentScanned: boolean;
  front: boolean;
  back: boolean;
  rotations: Record<IdSide, IdRotation>;
}

export type CopyFlowEvent =
  | { type: 'copy-type-selected'; copyType: CopyType }
  | { type: 'scan-started'; target: ScanTarget }
  | { type: 'scan-failed' }
  | { type: 'document-scanned' }
  | { type: 'side-scanned'; side: IdSide; warnings: IdScanWarning[] }
  | { type: 'warning-kept' }
  | { type: 'warning-retake' }
  | { type: 'side-rotated'; side: IdSide }
  | { type: 'start-over' }
  | { type: 'restored'; snapshot: CopyFlowSnapshot };

export function createCopyFlowState(
  copyType: CopyType = 'document',
): CopyFlowState {
  return {
    copyType,
    stage: 'capture',
    documentScanned: false,
    front: false,
    back: false,
    rotations: { front: 0, back: 0 },
    pendingWarnings: [],
    scanning: null,
  };
}

export function isCopyTypeLocked(state: CopyFlowState): boolean {
  return (
    state.scanning !== null ||
    state.documentScanned ||
    state.front ||
    state.back
  );
}

export function isSheetComplete(state: CopyFlowState): boolean {
  return state.copyType === 'document'
    ? state.documentScanned
    : state.front && state.back;
}

export function canContinue(state: CopyFlowState): boolean {
  return (
    state.stage === 'settings' &&
    isSheetComplete(state) &&
    state.pendingWarnings.length === 0 &&
    state.scanning === null
  );
}

export function nextIdScanTarget(state: CopyFlowState): IdSide | null {
  if (!state.front) return 'front';
  if (!state.back) return 'back';
  return null;
}

function nextRotation(rotation: IdRotation): IdRotation {
  return ((rotation + 90) % 360) as IdRotation;
}

export function reduceCopyFlow(
  state: CopyFlowState,
  event: CopyFlowEvent,
): CopyFlowState {
  switch (event.type) {
    case 'copy-type-selected':
      if (isCopyTypeLocked(state)) return state;
      return createCopyFlowState(event.copyType);

    case 'scan-started': {
      if (state.scanning !== null) return state;
      const isDocumentTarget = event.target === 'document';
      if (isDocumentTarget !== (state.copyType === 'document')) return state;
      return { ...state, scanning: event.target };
    }

    case 'scan-failed':
      return { ...state, scanning: null };

    case 'document-scanned':
      if (state.copyType !== 'document') return state;
      return {
        ...state,
        documentScanned: true,
        stage: 'settings',
        scanning: null,
      };

    case 'side-scanned': {
      if (state.copyType !== 'id') return state;
      const next: CopyFlowState = {
        ...state,
        [event.side]: true,
        rotations: { ...state.rotations, [event.side]: 0 },
        pendingWarnings: event.warnings,
        scanning: null,
      };
      const ready = next.front && next.back && event.warnings.length === 0;
      return { ...next, stage: ready ? 'settings' : state.stage };
    }

    case 'warning-kept': {
      const pendingWarnings = state.pendingWarnings.slice(1);
      const ready = pendingWarnings.length === 0 && isSheetComplete(state);
      return {
        ...state,
        pendingWarnings,
        stage: ready ? 'settings' : state.stage,
      };
    }

    case 'warning-retake':
      return { ...state, pendingWarnings: [] };

    case 'side-rotated':
      if (state.scanning !== null || !state[event.side]) return state;
      return {
        ...state,
        rotations: {
          ...state.rotations,
          [event.side]: nextRotation(state.rotations[event.side]),
        },
      };

    case 'start-over':
      return createCopyFlowState(state.copyType);

    case 'restored': {
      const restored: CopyFlowState = {
        ...createCopyFlowState(event.snapshot.copyType),
        documentScanned: event.snapshot.documentScanned,
        front: event.snapshot.front,
        back: event.snapshot.back,
        rotations: { ...event.snapshot.rotations },
      };
      return {
        ...restored,
        stage:
          event.snapshot.stage === 'settings' && isSheetComplete(restored)
            ? 'settings'
            : 'capture',
      };
    }

    default:
      return state;
  }
}

export function toSnapshot(state: CopyFlowState): CopyFlowSnapshot {
  return {
    copyType: state.copyType,
    stage: state.stage,
    documentScanned: state.documentScanned,
    front: state.front,
    back: state.back,
    rotations: { ...state.rotations },
  };
}

const QUARTER_TURNS = new Set<unknown>([0, 90, 180, 270]);

/** Reads a stored snapshot. Null for anything that is not a valid one. */
export function parseSnapshot(raw: string | null): CopyFlowSnapshot | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const source = value as Record<string, unknown>;
  if (source.copyType !== 'document' && source.copyType !== 'id') return null;
  if (source.stage !== 'capture' && source.stage !== 'settings') return null;
  const rotations = source.rotations as Record<string, unknown> | undefined;
  if (
    typeof rotations !== 'object' ||
    rotations === null ||
    !QUARTER_TURNS.has(rotations.front) ||
    !QUARTER_TURNS.has(rotations.back)
  ) {
    return null;
  }
  return {
    copyType: source.copyType,
    stage: source.stage,
    documentScanned: source.documentScanned === true,
    front: source.front === true,
    back: source.back === true,
    rotations: {
      front: rotations.front as IdRotation,
      back: rotations.back as IdRotation,
    },
  };
}
