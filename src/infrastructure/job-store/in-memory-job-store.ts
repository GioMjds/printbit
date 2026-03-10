import { jobStore } from '@/services';

export class InMemoryJobStore {
  getJob(jobId: string) {
    return jobStore.getJob(jobId);
  }
}
