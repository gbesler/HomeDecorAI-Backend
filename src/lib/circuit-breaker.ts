import { logger } from "./logger.js";
import type { ProviderId } from "./ai-providers/types.js";

export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

interface RequestRecord {
  success: boolean;
  timestamp: number;
}

interface CircuitBreakerOptions {
  name: string;
  bufferSize?: number;
  errorThresholdPercent?: number;
  recoverySuccessPercent?: number;
  /**
   * Provider served when the breaker is CLOSED (primary path). Defaults to
   * "replicate" for backward compatibility with the original design breaker.
   */
  primaryProvider?: ProviderId;
  /**
   * Provider served when the breaker is OPEN / HALF_OPEN (fallback path).
   * Defaults to "falai".
   */
  fallbackProvider?: ProviderId;
}

export type TransitionCallback = (
  name: string,
  from: CircuitState,
  to: CircuitState,
  stats: CircuitBreakerStats,
) => void;

export interface CircuitBreakerStats {
  bufferSize: number;
  errors: number;
  errorRate: number;
  probeBufferSize: number;
  probeSuccesses: number;
}

const DEFAULT_BUFFER_SIZE = 20;
const DEFAULT_ERROR_THRESHOLD_PERCENT = 30;
const DEFAULT_RECOVERY_SUCCESS_PERCENT = 90;

export class CircuitBreaker {
  readonly name: string;
  private state: CircuitState = CircuitState.CLOSED;
  private buffer: RequestRecord[] = [];
  private probeBuffer: RequestRecord[] = [];

  private readonly bufferSize: number;
  private readonly errorThresholdPercent: number;
  private readonly recoverySuccessPercent: number;
  readonly primaryProvider: ProviderId;
  readonly fallbackProvider: ProviderId;

  onTransition?: TransitionCallback;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
    this.errorThresholdPercent =
      options.errorThresholdPercent ?? DEFAULT_ERROR_THRESHOLD_PERCENT;
    this.recoverySuccessPercent =
      options.recoverySuccessPercent ?? DEFAULT_RECOVERY_SUCCESS_PERCENT;
    this.primaryProvider = options.primaryProvider ?? "replicate";
    this.fallbackProvider = options.fallbackProvider ?? "falai";
  }

  getState(): CircuitState {
    return this.state;
  }

  /** Returns the provider to use based on current circuit state */
  getProvider(): ProviderId {
    return this.state === CircuitState.CLOSED
      ? this.primaryProvider
      : this.fallbackProvider;
  }

  /** Whether the fallback provider should be used (breaker open or half-open) */
  shouldUseFallback(): boolean {
    return (
      this.state === CircuitState.OPEN ||
      this.state === CircuitState.HALF_OPEN
    );
  }

  record(success: boolean): void {
    const entry: RequestRecord = { success, timestamp: Date.now() };

    if (this.state === CircuitState.CLOSED) {
      this.pushToBuffer(this.buffer, entry);
      this.evaluateClosed();
    }
  }

  recordProbe(success: boolean): void {
    const entry: RequestRecord = { success, timestamp: Date.now() };

    if (this.state === CircuitState.OPEN) {
      if (success) {
        this.transitionTo(CircuitState.HALF_OPEN);
        this.probeBuffer = [entry];
      }
    } else if (this.state === CircuitState.HALF_OPEN) {
      this.pushToBuffer(this.probeBuffer, entry);
      this.evaluateHalfOpen();
    }
  }

  getStats(): CircuitBreakerStats {
    const errors = this.buffer.filter((r) => !r.success).length;
    const probeSuccesses = this.probeBuffer.filter((r) => r.success).length;
    return {
      bufferSize: this.buffer.length,
      errors,
      errorRate:
        this.buffer.length > 0
          ? Math.round((errors / this.buffer.length) * 100)
          : 0,
      probeBufferSize: this.probeBuffer.length,
      probeSuccesses,
    };
  }

  forceState(newState: CircuitState): void {
    this.transitionTo(newState);
  }

  private pushToBuffer(buf: RequestRecord[], entry: RequestRecord): void {
    buf.push(entry);
    if (buf.length > this.bufferSize) {
      buf.shift();
    }
  }

  private evaluateClosed(): void {
    if (this.buffer.length < 3) return;

    const errorCount = this.buffer.filter((r) => !r.success).length;
    const errorRate = (errorCount / this.buffer.length) * 100;

    if (errorRate > this.errorThresholdPercent) {
      this.transitionTo(CircuitState.OPEN);
    }
  }

  private evaluateHalfOpen(): void {
    if (this.probeBuffer.length < this.bufferSize) return;

    const successCount = this.probeBuffer.filter((r) => r.success).length;
    const successRate = (successCount / this.probeBuffer.length) * 100;

    if (successRate >= this.recoverySuccessPercent) {
      this.transitionTo(CircuitState.CLOSED);
    } else {
      const recentFailures = this.probeBuffer
        .slice(-5)
        .filter((r) => !r.success).length;
      if (recentFailures >= 3) {
        this.transitionTo(CircuitState.OPEN);
      }
    }
  }

  private transitionTo(newState: CircuitState): void {
    const prev = this.state;
    const stats = this.getStats();
    this.state = newState;

    if (newState === CircuitState.CLOSED) {
      this.buffer = [];
      this.probeBuffer = [];
    } else if (newState === CircuitState.OPEN) {
      this.probeBuffer = [];
    }

    logger.info(
      `[CircuitBreaker:${this.name}] ${prev} -> ${newState}`,
    );

    try {
      this.onTransition?.(this.name, prev, newState, stats);
    } catch (err) {
      logger.error(
        { err },
        `[CircuitBreaker:${this.name}] onTransition callback error`,
      );
    }
  }
}

/**
 * Design generation breaker for Replicate-primary tools (interior, exterior,
 * garden, patio, pool, virtual-staging, etc.). CLOSED → Replicate; OPEN →
 * fal.ai fallback. This is the breaker for the bulk of design traffic.
 */
export const designCircuitBreaker = new CircuitBreaker({
  name: "design",
  primaryProvider: "replicate",
  fallbackProvider: "falai",
});

/**
 * Design generation breaker for fal-primary tools (reference-style → Kontext
 * Max Multi, fallback to Replicate Nano Banana). Tracked independently from
 * `designCircuitBreaker` so Replicate degradation does not spuriously open
 * the breaker for traffic that starts on fal, and vice versa.
 */
export const designCircuitBreakerFalPrimary = new CircuitBreaker({
  name: "design-fal",
  primaryProvider: "falai",
  fallbackProvider: "replicate",
});
