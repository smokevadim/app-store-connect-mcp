/**
 * ES256 JWT signing for the App Store Connect API.
 *
 * Uses Node's built-in crypto — no third-party JWT dependency, so there is
 * no supply-chain surface between the private key and the signature.
 */
import { createSign, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
export const DEFAULT_JWT_LIFETIME_SECONDS = 1_080;
export const JWT_LIFETIME_MIN_SECONDS = 300;
export const JWT_LIFETIME_MAX_SECONDS = 1_199;
const REFRESH_LEEWAY_SEC = 90;
function base64url(input) {
    return Buffer.from(input)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}
/**
 * Converts a raw ECDSA signature (r||s) into the JOSE format Apple expects.
 * Node emits DER by default, so we ask for 'ieee-p1363' which is already r||s.
 */
function loadKey(creds) {
    let pem;
    if (creds.privateKey && creds.privateKey.trim()) {
        pem = creds.privateKey.replace(/\\n/g, '\n');
    }
    else if (creds.privateKeyPath) {
        pem = readFileSync(creds.privateKeyPath, 'utf8');
    }
    else {
        throw new Error('No private key supplied. Set ASC_PRIVATE_KEY_PATH or ASC_PRIVATE_KEY.');
    }
    try {
        return createPrivateKey({ key: pem, format: 'pem' });
    }
    catch (err) {
        throw new Error(`Failed to parse the private key. Make sure it is the unmodified .p8 file ` +
            `downloaded from App Store Connect. (${err.message})`);
    }
}
export class TokenProvider {
    creds;
    // Parsed lazily on the first mint, not at construction: listing tools never
    // signs anything, so the server can start (and expose tools/list to
    // introspection harnesses) without a usable key. An invalid key surfaces on
    // the first real API call instead of blocking startup.
    key;
    cached;
    lifetimeSeconds;
    constructor(creds, options = {}) {
        this.creds = creds;
        if (!creds.keyId)
            throw new Error('Missing key ID (ASC_KEY_ID).');
        if (!creds.issuerId)
            throw new Error('Missing issuer ID (ASC_ISSUER_ID).');
        const lifetimeSeconds = options.lifetimeSeconds ?? DEFAULT_JWT_LIFETIME_SECONDS;
        if (!Number.isSafeInteger(lifetimeSeconds) ||
            lifetimeSeconds < JWT_LIFETIME_MIN_SECONDS ||
            lifetimeSeconds > JWT_LIFETIME_MAX_SECONDS) {
            throw new Error(`JWT lifetime must be an integer between ${JWT_LIFETIME_MIN_SECONDS} and ` +
                `${JWT_LIFETIME_MAX_SECONDS} seconds.`);
        }
        this.lifetimeSeconds = lifetimeSeconds;
    }
    getKey() {
        if (!this.key)
            this.key = loadKey(this.creds);
        return this.key;
    }
    /** Returns a cached token when one is still comfortably valid. */
    getToken() {
        const now = Math.floor(Date.now() / 1000);
        if (this.cached && this.cached.expiresAt - now > REFRESH_LEEWAY_SEC) {
            return this.cached.token;
        }
        return this.mint(now);
    }
    /** Discards the cached token and signs a fresh one. */
    refresh() {
        this.cached = undefined;
        return this.mint(Math.floor(Date.now() / 1000));
    }
    status() {
        if (!this.cached)
            return { cached: false, expiresInSeconds: null };
        const now = Math.floor(Date.now() / 1000);
        return { cached: true, expiresInSeconds: this.cached.expiresAt - now };
    }
    mint(now) {
        const exp = now + this.lifetimeSeconds;
        const header = base64url(JSON.stringify({ alg: 'ES256', kid: this.creds.keyId, typ: 'JWT' }));
        const payload = base64url(JSON.stringify({
            iss: this.creds.issuerId,
            iat: now,
            exp,
            aud: 'appstoreconnect-v1',
        }));
        const signingInput = `${header}.${payload}`;
        const signer = createSign('SHA256');
        signer.update(signingInput);
        signer.end();
        // 'ieee-p1363' gives us the raw r||s pair that JOSE requires.
        const signature = signer.sign({ key: this.getKey(), dsaEncoding: 'ieee-p1363' });
        const token = `${signingInput}.${base64url(signature)}`;
        this.cached = { token, expiresAt: exp };
        return token;
    }
}
//# sourceMappingURL=jwt.js.map