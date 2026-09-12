/** Statuses the HTTP layer will retry; anything else is the caller's to fix. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
/** Structured error carrying whatever detail Apple returned. */
export class AscApiError extends Error {
    status;
    errors;
    requestId;
    constructor(message, status, errors = [], requestId) {
        super(message);
        this.status = status;
        this.errors = errors;
        this.requestId = requestId;
        this.name = 'AscApiError';
    }
    /**
     * Whether Apple refused because a legal agreement is unsigned rather than
     * because the key is scoped too narrowly. The two arrive as the same 403 and
     * lead opposite ways: one is fixed by the Account Holder accepting terms on
     * the developer website, the other by a role or a new key. Guessing wrong
     * costs an afternoon of rotating credentials that were never the problem.
     *
     * Apple has no endpoint that reports agreement state — `/v1/agreements` was
     * removed — so this error code is the only signal there is, and it only
     * appears once the grace period is over.
     */
    get requiresAgreement() {
        return (this.status === 403 &&
            this.errors.some((e) => String(e.code ?? '').startsWith('FORBIDDEN.REQUIRED_AGREEMENTS')));
    }
    /** A short, human-readable explanation suitable for showing to the caller. */
    get summary() {
        if (this.errors.length === 0)
            return this.message;
        return this.errors
            .map((e) => [e.title, e.detail].filter(Boolean).join(': '))
            .join(' | ');
    }
    /**
     * Whether trying again could work. Status 0 is a network or client-side
     * failure that never reached Apple, which is the most retryable case of all.
     */
    get retryable() {
        return this.status === 0 || RETRYABLE_STATUSES.has(this.status);
    }
}
export class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigError';
    }
}
//# sourceMappingURL=errors.js.map