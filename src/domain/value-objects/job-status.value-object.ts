export const JOB_STATUS = {
	QUEUED: 'queued',
	RUNNING: 'running',
	SUCCEEDED: 'succeeded',
	FAILED: 'failed',
} as const;

export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];
