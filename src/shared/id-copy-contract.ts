/** Wire types for the ID copy endpoints, shared by the server and /copy. */
import type { IdSide } from './id-card-layout';

export type IdScanWarningCode = 'side_blank' | 'sides_overlap';

export interface IdScanWarning {
  code: IdScanWarningCode;
  side: IdSide;
}

export interface IdCopySheetResponse {
  detected: true;
  sessionId: string;
  sides: { front: boolean; back: boolean };
  complete: boolean;
  previewPath: string;
  releaseToken: string;
  warnings: IdScanWarning[];
}

export interface IdCopyFailureResponse {
  detected: false;
  sessionId: string;
  code: string;
  error: string;
}

export const ID_SESSION_EXPIRED_CODE = 'ID_SESSION_EXPIRED';
