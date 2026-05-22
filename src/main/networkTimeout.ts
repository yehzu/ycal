// Hard ceiling for any single network round-trip. googleapis' per-call
// `timeout` option only covers the HTTP request itself, not the implicit
// OAuth token refresh that fires when the access token has expired — so we
// also race every call against this wall-clock timeout via withNetworkTimeout.
// Captive portals where DNS resolves but TCP hangs are the dominant case.
export const NETWORK_TIMEOUT_MS = 10_000;

export function withNetworkTimeout<T>(
  label: string,
  fn: () => Promise<T>,
  ms: number = NETWORK_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`${label} timed out after ${ms}ms`) as Error & { code?: string };
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
    fn().then(
      (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
