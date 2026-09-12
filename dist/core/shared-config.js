/**
 * One credential entry shared by every profile. `npx -y @erayendes/asc-mcp setup` writes it;
 * loadConfig falls back to it whenever the environment carries nothing. The
 * private key itself never lives in this file — on macOS it sits in the
 * Keychain and the file only holds the reference; elsewhere the file points
 * at the .p8 on disk.
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export function sharedConfigDir(env = process.env) {
    return env.ASC_CONFIG_DIR ?? join(homedir(), '.config', 'asc-mcp');
}
export function sharedConfigPath(env = process.env) {
    return join(sharedConfigDir(env), 'config.json');
}
/** Returns undefined when the file is absent; throws only on a corrupt file. */
export function readSharedConfig(env = process.env) {
    let raw;
    try {
        raw = readFileSync(sharedConfigPath(env), 'utf8');
    }
    catch {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw);
        return parsed.keyId && parsed.issuerId ? parsed : undefined;
    }
    catch {
        throw new Error(`${sharedConfigPath(env)} is not valid JSON. Re-run "npx -y @erayendes/asc-mcp setup" ` +
            `or delete the file.`);
    }
}
export function writeSharedConfig(config, env = process.env) {
    const dir = sharedConfigDir(env);
    mkdirSync(dir, { recursive: true });
    const path = sharedConfigPath(env);
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
    // Not secret material, but account identifiers still deserve owner-only.
    chmodSync(path, 0o600);
    return path;
}
//# sourceMappingURL=shared-config.js.map