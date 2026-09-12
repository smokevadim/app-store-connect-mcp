const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export class RateLimiter {
    hour;
    minute;
    /** Serialises admission so two callers can't both slip past a full window. */
    gate = Promise.resolve();
    constructor(opts = {}) {
        const now = Date.now();
        this.hour = {
            start: now,
            count: 0,
            limit: opts.requestsPerHour ?? 3600,
            durationMs: 3_600_000,
        };
        this.minute = {
            start: now,
            count: 0,
            limit: opts.requestsPerMinute ?? 300,
            durationMs: 60_000,
        };
    }
    /** Resolves once it is this caller's turn to issue a request. */
    async acquire() {
        const turn = this.gate.then(() => this.admit());
        // Swallow rejections on the chain itself so one failure can't wedge the gate.
        this.gate = turn.catch(() => undefined);
        return turn;
    }
    /** Feeds Apple's own rate-limit header back into our accounting. */
    observeHeader(header) {
        if (!header)
            return;
        // Format: "user-hour-lim:3600;user-hour-rem:2842;"
        const remaining = /user-hour-rem:(\d+)/.exec(header);
        const limit = /user-hour-lim:(\d+)/.exec(header);
        if (remaining && limit) {
            const lim = Number(limit[1]);
            const rem = Number(remaining[1]);
            if (Number.isFinite(lim) && Number.isFinite(rem)) {
                this.hour.limit = lim;
                this.hour.count = Math.max(this.hour.count, lim - rem);
            }
        }
    }
    status() {
        this.roll(this.hour);
        this.roll(this.minute);
        return {
            hourRemaining: Math.max(0, this.hour.limit - this.hour.count),
            minuteRemaining: Math.max(0, this.minute.limit - this.minute.count),
        };
    }
    async admit() {
        for (const w of [this.minute, this.hour]) {
            this.roll(w);
            if (w.count >= w.limit) {
                const waitMs = w.start + w.durationMs - Date.now();
                if (waitMs > 0)
                    await sleep(waitMs);
                this.roll(w);
            }
        }
        this.minute.count++;
        this.hour.count++;
    }
    roll(w) {
        const now = Date.now();
        if (now - w.start >= w.durationMs) {
            w.start = now;
            w.count = 0;
        }
    }
}
//# sourceMappingURL=rate-limit.js.map