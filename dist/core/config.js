import { ConfigError } from './errors.js';
import { readKeychainPassword } from './keychain.js';
import { readSharedConfig } from './shared-config.js';
import { DEFAULT_JWT_LIFETIME_SECONDS, JWT_LIFETIME_MAX_SECONDS, JWT_LIFETIME_MIN_SECONDS, } from './jwt.js';
import { AUTH_RETRY_DELAY_MAX_MS, AUTH_RETRY_DELAY_MIN_MS, DEFAULT_AUTH_RETRY_DELAY_MS, } from './http.js';
function parseList(value) {
    if (!value)
        return undefined;
    const items = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return items.length ? items : undefined;
}
function parseBoundedInteger(raw, name, min, max, fallback) {
    if (raw === undefined)
        return fallback;
    const trimmed = raw.trim();
    const value = Number(trimmed);
    if (!trimmed ||
        !Number.isSafeInteger(value) ||
        value < min ||
        value > max) {
        throw new ConfigError(`${name} must be an integer between ${min} and ${max}. ` +
            `Unset it to use the default of ${fallback}.`);
    }
    return value;
}
export function loadConfig(argv = process.argv.slice(2)) {
    const env = process.env;
    const flag = (name) => argv.includes(`--${name}`);
    const option = (name) => {
        const inline = argv.find((a) => a.startsWith(`--${name}=`));
        if (inline)
            return inline.slice(name.length + 3);
        const idx = argv.indexOf(`--${name}`);
        if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) {
            return argv[idx + 1];
        }
        return undefined;
    };
    // The environment wins outright; the shared file (written by `setup`) fills
    // in only when the env carries no credentials at all, so one stray env var
    // can't silently mix two accounts.
    const envHasCreds = Boolean(env.ASC_KEY_ID || env.ASC_ISSUER_ID || env.ASC_PRIVATE_KEY ||
        env.ASC_PRIVATE_KEY_KEYCHAIN || env.ASC_PRIVATE_KEY_PATH);
    const shared = envHasCreds ? undefined : readSharedConfig(env);
    const keyId = env.ASC_KEY_ID ?? shared?.keyId;
    const issuerId = env.ASC_ISSUER_ID ?? shared?.issuerId;
    const privateKeyPath = env.ASC_PRIVATE_KEY_PATH ?? shared?.privateKeyPath;
    const keychainRef = env.ASC_PRIVATE_KEY_KEYCHAIN ?? shared?.privateKeyKeychain;
    // Resolve the key from the Keychain unless an inline PEM already wins.
    // Precedence: ASC_PRIVATE_KEY > keychain reference > file path.
    const privateKey = env.ASC_PRIVATE_KEY ?? (keychainRef ? readKeychainPassword(keychainRef) : undefined);
    const missing = [];
    if (!keyId)
        missing.push('ASC_KEY_ID');
    if (!issuerId)
        missing.push('ASC_ISSUER_ID');
    if (!privateKeyPath && !privateKey) {
        missing.push('ASC_PRIVATE_KEY_PATH (or ASC_PRIVATE_KEY, or ASC_PRIVATE_KEY_KEYCHAIN)');
    }
    if (missing.length) {
        throw new ConfigError(`Missing required configuration: ${missing.join(', ')}.\n` +
            `Either run "npx -y @erayendes/asc-mcp setup" once (shared by every profile), or ` +
            `create an API key at https://appstoreconnect.apple.com/access/integrations/api ` +
            `and set these as environment variables in your MCP client config.`);
    }
    const bundleId = env.ASC_BUNDLE_ID ?? shared?.bundleId;
    // A zero or a typo would silently stall every request, so only a positive
    // number counts; anything else falls back to Apple's documented ceiling.
    const positive = (raw) => {
        const n = Number(raw);
        return raw && Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const requestsPerHour = positive(env.ASC_RATE_LIMIT_PER_HOUR);
    const requestsPerMinute = positive(env.ASC_RATE_LIMIT_PER_MINUTE);
    return {
        credentials: {
            keyId: keyId,
            issuerId: issuerId,
            privateKeyPath,
            privateKey,
        },
        vendorNumber: env.ASC_VENDOR_NUMBER ?? shared?.vendorNumber,
        storekit: bundleId
            ? {
                bundleId,
                appAppleId: env.ASC_APP_APPLE_ID
                    ? Number(env.ASC_APP_APPLE_ID)
                    : shared?.appAppleId,
                environment: (env.ASC_ENVIRONMENT ?? shared?.environment) === 'Production'
                    ? 'Production'
                    : 'Sandbox',
                // Apple's DER root certificates, which the App Store Server Library
                // asks the caller for rather than shipping. Comma-separated paths, or
                // one directory. Unset means the StoreKit reads keep handing back the
                // signed envelope — the honest default, since decoding without
                // verifying would present unverified data as fact.
                appleRootCerts: parseList(env.ASC_APPLE_ROOT_CERTS),
            }
            : undefined,
        domains: parseList(option('domains') ?? env.ASC_DOMAINS),
        readOnly: flag('read-only') || env.ASC_READ_ONLY === 'true',
        // `strong` by default: ask on the four levels the risk manifest calls
        // revenue, destructive, infrastructure and access, and stay out of the way
        // on the rest.
        //
        // The two extremes were both tried and both wrong. On by default fired on
        // every write, and a client that declares elicitation but cannot render the
        // form answers `decline` — indistinguishable, in the protocol, from a user
        // refusing — so ordinary writes came back as "you refused" on those
        // clients. Off by default made the misfire go away by removing the guard
        // from the writes that move money and hand out Admin, which is the one
        // place it was worth its cost. This keeps it where the blast radius is.
        confirmWrites: flag('confirm') || env.ASC_CONFIRM_WRITES === 'true' || env.ASC_CONFIRM_WRITES === '1'
            ? 'all'
            : flag('no-confirm') ||
                env.ASC_CONFIRM_WRITES === 'false' ||
                env.ASC_CONFIRM_WRITES === '0'
                ? 'off'
                : 'strong',
        includeDeprecated: flag('include-deprecated') || env.ASC_INCLUDE_DEPRECATED === 'true',
        baseUrl: env.ASC_BASE_URL || undefined,
        jwtLifetimeSeconds: parseBoundedInteger(env.ASC_JWT_LIFETIME_SECONDS, 'ASC_JWT_LIFETIME_SECONDS', JWT_LIFETIME_MIN_SECONDS, JWT_LIFETIME_MAX_SECONDS, DEFAULT_JWT_LIFETIME_SECONDS),
        authRetryDelayMs: parseBoundedInteger(env.ASC_AUTH_RETRY_DELAY_MS, 'ASC_AUTH_RETRY_DELAY_MS', AUTH_RETRY_DELAY_MIN_MS, AUTH_RETRY_DELAY_MAX_MS, DEFAULT_AUTH_RETRY_DELAY_MS),
        dryRun: flag('dry-run') || env.ASC_DRY_RUN === 'true' || env.ASC_DRY_RUN === '1',
        rateLimit: requestsPerHour || requestsPerMinute ? { requestsPerHour, requestsPerMinute } : undefined,
        reviewsBrand: env.ASC_REVIEWS_BRAND_VOICE || env.ASC_REVIEWS_BANNED_PHRASES || env.ASC_REVIEWS_SUPPORT_URL
            ? {
                voice: env.ASC_REVIEWS_BRAND_VOICE || undefined,
                bannedPhrases: parseList(env.ASC_REVIEWS_BANNED_PHRASES),
                supportUrl: env.ASC_REVIEWS_SUPPORT_URL || undefined,
            }
            : undefined,
    };
}
//# sourceMappingURL=config.js.map