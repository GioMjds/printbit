/**
 * Worker-thread entry point for document analysis.
 *
 * Built as its own bundle (dist/document-analysis-worker.js) next to the
 * server bundle. The server starts it through runAnalysisInWorker, passing
 * the request as workerData, and receives one message with the outcome.
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { analyzeDocument, type AnalyzeDocumentInput } from './document-analysis';
import type {
  AnalysisWorkerInput,
  AnalysisWorkerMessage,
} from './document-analysis-thread';

if (!isMainThread && parentPort) {
  const port = parentPort;
  const post = (message: AnalysisWorkerMessage<unknown>): void => {
    port.postMessage(message);
  };

  // Inside a worker analyzeDocument runs the analysis directly.
  analyzeDocument(workerData as AnalysisWorkerInput as AnalyzeDocumentInput)
    .then((result) => post({ type: 'success', result }))
    .catch((error: unknown) =>
      post({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
}
