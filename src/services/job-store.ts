import { randomUUID } from "node:crypto";

// Types
export type JobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancel_requested"
  | "cancelled";
export type JobType = "copy" | "scan";
export type ScanFormat = "pdf" | "jpg" | "png";
export type PageSource = "adf" | "flatbed";

export interface JobProgress {
  pagesCompleted: number;
  pagesTotal: number | null;
}

export interface JobFailure {
  code: string;
  message: string;
  retryable: boolean;
  stage: "precheck" | "running" | "postprocess";
}

export interface CopyJobSettings {
  copies: number;
  colorMode: "colored" | "grayscale";
  orientation: "portrait" | "landscape";
  paperSize: "A4" | "Letter" | "Legal";
}

export interface ScanJobSettings {
  source: PageSource;
  dpi: number;
  colorMode: "colored" | "grayscale";
  duplex: boolean;
  format: ScanFormat;
}

export interface BaseJob {
  id: string;
  type: JobType;
  state: JobState;
  progress: JobProgress | null;
  failure: JobFailure | null;
  createdAt: string;
  updatedAt: string;
}

export interface CopyJob extends BaseJob {
  type: "copy";
  settings: CopyJobSettings;
  payment: { chargedAmount: number; remainingBalance: number } | null;
}

export interface ScanJob extends BaseJob {
  type: "scan";
  settings: ScanJobSettings;
  resultPath: string | null;
}

export type Job = CopyJob | ScanJob;

interface UpdateExtra {
  progress?: JobProgress;
  failure?: JobFailure;
  resultPath?: string;
}

class JobStore {
  private jobs: Map<string, Job> = new Map();

  createCopyJob(
    settings: CopyJobSettings,
    payment: CopyJob["payment"],
  ): CopyJob {
    const now = new Date().toISOString();
    const job: CopyJob = {
      id: randomUUID(),
      type: "copy",
      state: "queued",
      progress: null,
      failure: null,
      createdAt: now,
      updatedAt: now,
      settings,
      payment,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  createScanJob(settings: ScanJobSettings): ScanJob {
    const now = new Date().toISOString();
    const job: ScanJob = {
      id: randomUUID(),
      type: "scan",
      state: "queued",
      progress: null,
      failure: null,
      createdAt: now,
      updatedAt: now,
      settings,
      resultPath: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  updateJobState(id: string, state: JobState, extra?: UpdateExtra): void {
    const job = this.jobs.get(id);
    if (!job) return;

    job.state = state;
    job.updatedAt = new Date().toISOString();

    if (extra?.progress !== undefined) {
      job.progress = extra.progress;
    }
    if (extra?.failure !== undefined) {
      job.failure = extra.failure;
    }
    if (extra?.resultPath !== undefined && job.type === "scan") {
      job.resultPath = extra.resultPath;
    }
  }

  requestCancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || (job.state !== "queued" && job.state !== "running")) {
      return false;
    }
    job.state = "cancel_requested";
    job.updatedAt = new Date().toISOString();
    return true;
  }
}

export const jobStore = new JobStore();
