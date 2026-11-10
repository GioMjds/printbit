/**
 * fetch() with a hard client-side deadline. On timeout the request is aborted and
 * an Error("<label> timed out after N seconds") is thrown; other errors pass through.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      throw new Error(
        `${label} timed out after ${Math.round(timeoutMs / 1000)} seconds`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
