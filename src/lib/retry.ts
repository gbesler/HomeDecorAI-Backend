interface RetryOptions {
  maxRetries: number;
  delayMs?: number;
  onRetry?: (error: Error, attempt: number) => void;
  /**
   * Predicate to skip retry for domain errors that are not transient.
   * Return `false` to propagate the error immediately. Example: a
   * Grounded-SAM "no mask detected" result is a valid terminal outcome,
   * not a provider outage — retrying just bills a second SAM call for
   * the same deterministic answer.
   */
  isRetryable?: (error: Error) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { maxRetries, delayMs = 1000, onRetry, isRetryable } = options;

  let lastError: Error = new Error("withRetry: no attempts made");

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (isRetryable && !isRetryable(lastError)) {
        throw lastError;
      }

      if (attempt < maxRetries) {
        onRetry?.(lastError, attempt + 1);
        // Add jitter to prevent thundering-herd retry storms
        const jitter = Math.random() * delayMs;
        await new Promise((resolve) => setTimeout(resolve, delayMs + jitter));
      }
    }
  }

  throw lastError;
}
