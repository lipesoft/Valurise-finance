export class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** Bounds an asynchronous dependency so a stalled request cannot hold the UI indefinitely. */
export function withTimeout<T>(operation: PromiseLike<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(message)), timeoutMs);
  });

  return Promise.race([Promise.resolve(operation), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
