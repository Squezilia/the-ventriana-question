import type { RunHealthStats } from "../../contracts/stream.ts";

export interface RateLimiterOptions {
  rpmLimit: number;
  tpmLimit: number;
  maxConcurrency: number;
  maxTotalCalls: number; // 0 = unlimited
  dailyCallBudget: number; // 0 = unlimited
}

export class RateLimiter {
  private readonly opts: RateLimiterOptions;
  private activeCount = 0;
  private readonly waitQueue: Array<() => void> = [];
  private readonly callTimestamps: number[] = [];
  private readonly tokenWindow: Array<{ ts: number; tokens: number }> = [];

  private totalCalls = 0;
  private dailyCalls = 0;
  private throttledCount = 0;
  private rateLimit429Count = 0;
  private retryCount = 0;
  private invalidOutputCount = 0;
  private safetyBlockCount = 0;
  private promptTokensTotal = 0;
  private completionTokensTotal = 0;

  constructor(opts: RateLimiterOptions) {
    this.opts = opts;
  }

  resetDailyCounter(): void {
    this.dailyCalls = 0;
  }

  isBudgetExhausted(): { exhausted: boolean; reason?: string } {
    if (this.opts.maxTotalCalls > 0 && this.totalCalls >= this.opts.maxTotalCalls) {
      return {
        exhausted: true,
        reason: `MAX_TOTAL_CALLS (${this.opts.maxTotalCalls}) reached`,
      };
    }
    if (this.opts.dailyCallBudget > 0 && this.dailyCalls >= this.opts.dailyCallBudget) {
      return {
        exhausted: true,
        reason: `DAILY_CALL_BUDGET (${this.opts.dailyCallBudget}) reached`,
      };
    }
    return { exhausted: false };
  }

  recordAttempt(info: {
    promptTokens: number;
    completionTokens: number;
    retries: number;
    invalidOutput: boolean;
    safetyBlocked: boolean;
    rateLimit429?: boolean;
  }): void {
    this.totalCalls += 1;
    this.dailyCalls += 1;
    this.promptTokensTotal += info.promptTokens;
    this.completionTokensTotal += info.completionTokens;
    this.retryCount += info.retries;
    if (info.invalidOutput) this.invalidOutputCount += 1;
    if (info.safetyBlocked) this.safetyBlockCount += 1;
    if (info.rateLimit429) this.rateLimit429Count += 1;

    const now = Date.now();
    this.callTimestamps.push(now);
    const totalTok = info.promptTokens + info.completionTokens;
    if (totalTok > 0) {
      this.tokenWindow.push({ ts: now, tokens: totalTok });
    }
    this.pruneWindows(now);
  }

  record429(): void {
    this.rateLimit429Count += 1;
  }

  getHealth(estimatedSecondsRemaining: number | null = null): RunHealthStats {
    this.pruneWindows(Date.now());
    return {
      callsLastMinute: this.callTimestamps.length,
      totalCalls: this.totalCalls,
      throttledCount: this.throttledCount,
      rateLimit429Count: this.rateLimit429Count,
      retryCount: this.retryCount,
      invalidOutputCount: this.invalidOutputCount,
      safetyBlockCount: this.safetyBlockCount,
      promptTokensTotal: this.promptTokensTotal,
      completionTokensTotal: this.completionTokensTotal,
      estimatedSecondsRemaining,
    };
  }

  private pruneWindows(now: number): void {
    const cutoff = now - 60_000;
    while (this.callTimestamps.length > 0 && this.callTimestamps[0]! < cutoff) {
      this.callTimestamps.shift();
    }
    while (this.tokenWindow.length > 0 && this.tokenWindow[0]!.ts < cutoff) {
      this.tokenWindow.shift();
    }
  }

  async run<T>(estimatedTokens: number, fn: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      await this.waitForRateWindow(estimatedTokens);
      return await fn();
    } finally {
      this.releaseSlot();
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeCount < this.opts.maxConcurrency) {
      this.activeCount += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.activeCount += 1;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
    const next = this.waitQueue.shift();
    if (next) next();
  }

  private async waitForRateWindow(estimatedTokens: number): Promise<void> {
    while (true) {
      const now = Date.now();
      this.pruneWindows(now);

      const rpmExceeded =
        this.opts.rpmLimit > 0 && this.callTimestamps.length >= this.opts.rpmLimit;
      const currentTokens = this.tokenWindow.reduce((sum, x) => sum + x.tokens, 0);
      const tpmExceeded =
        this.opts.tpmLimit > 0 && currentTokens + estimatedTokens > this.opts.tpmLimit;

      if (!rpmExceeded && !tpmExceeded) {
        return;
      }

      this.throttledCount += 1;
      let waitMs = 1000;
      if (rpmExceeded && this.callTimestamps[0]) {
        waitMs = Math.max(waitMs, this.callTimestamps[0] + 60_000 - now + 50);
      }
      if (tpmExceeded && this.tokenWindow[0]) {
        waitMs = Math.max(waitMs, this.tokenWindow[0].ts + 60_000 - now + 50);
      }
      const cappedWait = Math.min(waitMs, 5000);
      console.warn(`[RateLimiter] Throttled (${rpmExceeded ? "RPM" : "TPM"}), waiting ${cappedWait}ms`);
      await new Promise((r) => setTimeout(r, cappedWait));
    }
  }
}
