import type { RunHealthStats } from "../../contracts/stream.ts";

export interface RateLimiterOptions {
  rpmLimit: number;
  tpmLimit: number;
  maxConcurrency: number;
  maxTotalCalls: number; // 0 = unlimited
  dailyCallBudget: number; // 0 = unlimited
}

export interface RateReservation {
  settle(actualTokens?: number): void;
}

interface CallWindowEntry {
  ts: number;
}

interface TokenWindowEntry {
  ts: number;
  tokens: number;
}

function calendarDayKey(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class RateLimiter {
  private readonly opts: RateLimiterOptions;
  private activeCount = 0;
  private readonly waitQueue: Array<() => void> = [];
  private readonly callTimestamps: CallWindowEntry[] = [];
  private readonly tokenWindow: TokenWindowEntry[] = [];
  private cooldownUntilMs = 0;
  private currentDayKey: string;

  private totalCalls = 0;
  private dailyCalls = 0;
  private throttledCount = 0;
  private rateLimit429Count = 0;
  private retryCount = 0;
  private invalidOutputCount = 0;
  private safetyBlockCount = 0;
  private promptTokensTotal = 0;
  private completionTokensTotal = 0;
  private cachedTokensTotal = 0;

  constructor(opts: RateLimiterOptions) {
    this.opts = opts;
    this.currentDayKey = calendarDayKey();
  }

  private syncCalendarDay(nowMs: number = Date.now()): void {
    const today = calendarDayKey(nowMs);
    if (today !== this.currentDayKey) {
      this.currentDayKey = today;
      this.dailyCalls = 0;
    }
  }

  resetDailyCounter(): void {
    this.currentDayKey = calendarDayKey();
    this.dailyCalls = 0;
  }

  seedTotals(totals: {
    totalCalls?: number;
    dailyCalls?: number;
    retryCount?: number;
    invalidOutputCount?: number;
    safetyBlockCount?: number;
    promptTokensTotal?: number;
    completionTokensTotal?: number;
    cachedTokensTotal?: number;
  }): void {
    this.syncCalendarDay();
    if (totals.totalCalls !== undefined) this.totalCalls = totals.totalCalls;
    if (totals.dailyCalls !== undefined) this.dailyCalls = totals.dailyCalls;
    if (totals.retryCount !== undefined) this.retryCount = totals.retryCount;
    if (totals.invalidOutputCount !== undefined) this.invalidOutputCount = totals.invalidOutputCount;
    if (totals.safetyBlockCount !== undefined) this.safetyBlockCount = totals.safetyBlockCount;
    if (totals.promptTokensTotal !== undefined) this.promptTokensTotal = totals.promptTokensTotal;
    if (totals.completionTokensTotal !== undefined) {
      this.completionTokensTotal = totals.completionTokensTotal;
    }
    if (totals.cachedTokensTotal !== undefined) this.cachedTokensTotal = totals.cachedTokensTotal;
  }

  isBudgetExhausted(): { exhausted: boolean; reason?: string } {
    this.syncCalendarDay();
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
    cachedTokens?: number;
    retries: number;
    invalidOutput: boolean;
    safetyBlocked: boolean;
    rateLimit429?: boolean;
    alreadyWindowTracked?: boolean;
  }): void {
    const now = Date.now();
    this.syncCalendarDay(now);
    this.totalCalls += 1;
    this.dailyCalls += 1;
    this.promptTokensTotal += info.promptTokens;
    this.completionTokensTotal += info.completionTokens;
    this.cachedTokensTotal += info.cachedTokens ?? 0;
    this.retryCount += info.retries;
    if (info.invalidOutput) this.invalidOutputCount += 1;
    if (info.safetyBlocked) this.safetyBlockCount += 1;
    if (info.rateLimit429) this.rateLimit429Count += 1;

    if (!info.alreadyWindowTracked) {
      this.callTimestamps.push({ ts: now });
      const totalTok = info.promptTokens + info.completionTokens;
      if (totalTok > 0) {
        this.tokenWindow.push({ ts: now, tokens: totalTok });
      }
      this.pruneWindows(now);
    }
  }

  record429(cooldownMs: number = 0): void {
    this.rateLimit429Count += 1;
    if (cooldownMs > 0) {
      const target = Date.now() + cooldownMs;
      if (target > this.cooldownUntilMs) {
        this.cooldownUntilMs = target;
      }
    }
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
      cachedTokensTotal: this.cachedTokensTotal,
      estimatedSecondsRemaining,
    };
  }

  private pruneWindows(now: number): void {
    const cutoff = now - 60_000;
    while (this.callTimestamps.length > 0 && this.callTimestamps[0]!.ts < cutoff) {
      this.callTimestamps.shift();
    }
    while (this.tokenWindow.length > 0 && this.tokenWindow[0]!.ts < cutoff) {
      this.tokenWindow.shift();
    }
  }

  async run<T>(estimatedTokens: number, fn: (reservation: RateReservation) => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      const reservation = await this.reserveRateWindow(estimatedTokens);
      return await fn(reservation);
    } finally {
      this.releaseSlot();
    }
  }

  private async acquireSlot(): Promise<void> {
    const limit = Math.max(1, this.opts.maxConcurrency);
    if (this.activeCount < limit) {
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

  private async reserveRateWindow(estimatedTokens: number): Promise<RateReservation> {
    const est = Math.max(0, Math.ceil(estimatedTokens));
    let wasThrottled = false;

    while (true) {
      const now = Date.now();
      this.pruneWindows(now);

      const cooldownRemaining = Math.max(0, this.cooldownUntilMs - now);
      const rpmExceeded =
        this.opts.rpmLimit > 0 && this.callTimestamps.length >= this.opts.rpmLimit;
      const currentTokens = this.tokenWindow.reduce((sum, x) => sum + x.tokens, 0);
      // Only gate on TPM when there are existing tokens in the window; otherwise an oversized
      // single prompt can never drain and would loop forever.
      const tpmExceeded =
        this.opts.tpmLimit > 0 &&
        currentTokens > 0 &&
        currentTokens + est > this.opts.tpmLimit;

      if (cooldownRemaining <= 0 && !rpmExceeded && !tpmExceeded) {
        if (this.opts.tpmLimit > 0 && currentTokens === 0 && est > this.opts.tpmLimit) {
          console.warn(
            `[RateLimiter] Single request (~${est} tokens) exceeds TPM_LIMIT (${this.opts.tpmLimit}); admitting on empty window`
          );
        }

        const callEntry: CallWindowEntry = { ts: now };
        this.callTimestamps.push(callEntry);

        let tokenEntry: TokenWindowEntry | null = null;
        if (est > 0) {
          tokenEntry = { ts: now, tokens: est };
          this.tokenWindow.push(tokenEntry);
        }

        let settled = false;
        return {
          settle: (actualTokens?: number) => {
            if (settled) return;
            settled = true;
            if (actualTokens === undefined) return;
            const settledNow = Date.now();
            const normalized = Math.max(0, Math.round(actualTokens));
            if (normalized === 0) {
              if (tokenEntry) {
                const idx = this.tokenWindow.indexOf(tokenEntry);
                if (idx >= 0) this.tokenWindow.splice(idx, 1);
                tokenEntry = null;
              }
              return;
            }
            if (tokenEntry) {
              tokenEntry.tokens = normalized;
              tokenEntry.ts = settledNow;
            } else {
              tokenEntry = { ts: settledNow, tokens: normalized };
              this.tokenWindow.push(tokenEntry);
            }
          },
        };
      }

      if (!wasThrottled) {
        this.throttledCount += 1;
        wasThrottled = true;
      }

      let waitMs = Math.max(cooldownRemaining, 100);
      if (rpmExceeded && this.callTimestamps[0]) {
        waitMs = Math.max(waitMs, this.callTimestamps[0].ts + 60_000 - now + 50);
      }
      if (tpmExceeded && this.tokenWindow[0]) {
        waitMs = Math.max(waitMs, this.tokenWindow[0].ts + 60_000 - now + 50);
      }
      const cappedWait = Math.min(waitMs, 5000);
      const reason = rpmExceeded ? "RPM" : tpmExceeded ? "TPM" : "429-cooldown";
      console.warn(`[RateLimiter] Throttled (${reason}), waiting ${cappedWait}ms`);
      await new Promise((r) => setTimeout(r, cappedWait));
    }
  }
}
