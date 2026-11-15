import {
  applyConfirmationEvidence,
  createConfirmationOutcomeState,
  type ConfirmationEvidence,
  type ConfirmationOutcomeState,
} from './confirmation-outcome';

export interface JobState<O> {
  processing: boolean;
  activeSpoolerKey: string | null;
  transactionId: string | null;
  owedChange: O | null;
  outcome: ConfirmationOutcomeState;
}

export type JobEvent<O> =
  | { type: 'submit-started' }
  | { type: 'processing-stopped' }
  | { type: 'spooler-activated'; key: string | null }
  | { type: 'spooler-cleared' }
  | { type: 'transaction-referenced'; id: string | null }
  | { type: 'owed-change-recorded'; notice: O }
  | { type: 'owed-change-cleared' }
  | { type: 'outcome-evidence'; evidence: ConfirmationEvidence }
  | { type: 'session-cleared' };

export type JobPhase =
  | 'idle'
  | 'submitting'
  | 'awaiting-worker'
  | 'interrupted'
  | 'succeeded';

export function createJobState<O>(): JobState<O> {
  return {
    processing: false,
    activeSpoolerKey: null,
    transactionId: null,
    owedChange: null,
    outcome: createConfirmationOutcomeState(),
  };
}

export function reduceJob<O>(
  state: JobState<O>,
  event: JobEvent<O>,
): JobState<O> {
  switch (event.type) {
    case 'submit-started':
      return { ...state, processing: true };
    case 'processing-stopped':
      return { ...state, processing: false };
    case 'spooler-activated':
      return { ...state, activeSpoolerKey: event.key };
    case 'spooler-cleared':
      return { ...state, activeSpoolerKey: null };
    case 'transaction-referenced':
      return {
        ...state,
        transactionId: event.id?.trim().length ? event.id.trim() : null,
      };
    case 'owed-change-recorded':
      return { ...state, owedChange: event.notice };
    case 'owed-change-cleared':
      return { ...state, owedChange: null };
    case 'outcome-evidence':
      return {
        ...state,
        outcome: applyConfirmationEvidence(state.outcome, event.evidence),
      };
    case 'session-cleared':
      return {
        ...state,
        outcome: createConfirmationOutcomeState(),
        transactionId: null,
        owedChange: null,
      };
  }
}

export function getJobPhase<O>(state: JobState<O>): JobPhase {
  if (state.outcome.outcome === 'success') return 'succeeded';
  if (state.outcome.outcome === 'maintenance') return 'interrupted';
  if (state.activeSpoolerKey !== null) return 'awaiting-worker';
  if (state.processing) return 'submitting';
  return 'idle';
}

export function hasActiveJob<O>(
  state: JobState<O>,
  persistedSpoolerKey: string | null,
): boolean {
  return (
    state.processing ||
    state.activeSpoolerKey !== null ||
    persistedSpoolerKey !== null
  );
}
