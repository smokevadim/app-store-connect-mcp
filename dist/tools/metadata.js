import { AscApiError } from '../core/errors.js';
import { resolveApp } from '../core/resolve-app.js';
/**
 * The editable text fields on an App Store version localization. `locale` is
 * the key rather than a field, and the rest of what Apple returns is
 * relationships, so this is the whole comparable surface.
 */
export const COMPARED_FIELDS = [
    'description',
    'keywords',
    'whatsNew',
    'promotionalText',
    'marketingUrl',
    'supportUrl',
];
/** How much of a changed value comes back. Enough to recognise, not to reprint. */
const PREVIEW_CHARS = 160;
/**
 * States in which a version is the one customers see. `READY_FOR_SALE` is the
 * usual answer; a phased release is still live to part of the audience, and
 * `PENDING_DEVELOPER_RELEASE` is approved and held, which makes it the text
 * that ships next rather than the text on sale — it is reported, and named.
 */
const LIVE_STATES = new Set([
    'READY_FOR_SALE',
    'PENDING_DEVELOPER_RELEASE',
    'PROCESSING_FOR_APP_STORE',
]);
export const METADATA_TOOLS = [
    {
        name: 'listing__diff_metadata',
        description: 'Compare the store text of two app versions locale by locale, in one call, and ' +
            'list only what differs. Give the app (name, bundle ID or Apple ID). By default ' +
            'it compares the version that is on sale against the one being prepared, which is ' +
            'the answer to "what am I about to change?". Reports per locale which of ' +
            'description, keywords, whatsNew, promotional text, marketing URL and support URL ' +
            'changed, plus locales added or dropped. Read-only.',
        inputSchema: {
            type: 'object',
            properties: {
                app: {
                    type: 'string',
                    description: 'App name, bundle ID (com.example.app) or numeric Apple ID.',
                },
                from: {
                    type: 'string',
                    description: 'Version string to compare from. Defaults to the version on sale.',
                },
                to: {
                    type: 'string',
                    description: 'Version string to compare to. Defaults to the version being prepared.',
                },
                locale: {
                    type: 'string',
                    description: 'Restrict to one locale (e.g. "en-US", "tr"). Omit to compare every locale.',
                },
            },
            required: ['app'],
        },
        outputSchema: {
            type: 'object',
            properties: {
                app: { type: 'string' },
                from: { type: 'object', description: 'version and appStoreState of the baseline.' },
                to: { type: 'object', description: 'version and appStoreState of the comparison.' },
                identical: { type: 'boolean', description: 'True when no compared field differs.' },
                changed: {
                    type: 'array',
                    description: 'One entry per locale that differs, carrying only the changed fields.',
                    items: {
                        type: 'object',
                        properties: {
                            locale: { type: 'string' },
                            fields: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        field: { type: 'string' },
                                        from: { type: 'string' },
                                        to: { type: 'string' },
                                        truncated: { type: 'boolean' },
                                    },
                                    required: ['field', 'from', 'to'],
                                },
                            },
                        },
                        required: ['locale', 'fields'],
                    },
                },
                localesAdded: {
                    type: 'array',
                    description: 'Locales present in "to" and absent from "from".',
                    items: { type: 'string' },
                },
                localesRemoved: {
                    type: 'array',
                    description: 'Locales present in "from" and absent from "to" — these stop being served.',
                    items: { type: 'string' },
                },
                unchangedLocales: { type: 'number' },
            },
            required: ['app', 'from', 'to', 'identical', 'changed', 'localesAdded', 'localesRemoved'],
        },
        annotations: { readOnlyHint: true },
    },
];
export const METADATA_TOOL_NAMES = new Set(METADATA_TOOLS.map((t) => t.name));
/**
 * Apple stores an absent field as null and a cleared one as "", and a caller
 * cannot act on that distinction — both render as nothing on the listing.
 */
const norm = (v) => (v == null ? '' : String(v));
function preview(value) {
    const collapsed = value.replace(/\s+/g, ' ').trim();
    return collapsed.length <= PREVIEW_CHARS
        ? { text: collapsed, truncated: false }
        : { text: `${collapsed.slice(0, PREVIEW_CHARS)}…`, truncated: true };
}
/** Exported for the unit test: the comparison is the part worth pinning. */
export function diffLocalizations(from, to) {
    const changed = [];
    let unchangedLocales = 0;
    for (const [locale, after] of [...to.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const before = from.get(locale);
        if (!before)
            continue; // A new locale is reported as added, not as six changed fields.
        const fields = [];
        for (const field of COMPARED_FIELDS) {
            const a = norm(before[field]);
            const b = norm(after[field]);
            if (a === b)
                continue;
            const pa = preview(a);
            const pb = preview(b);
            const change = { field, from: pa.text, to: pb.text };
            if (pa.truncated || pb.truncated)
                change.truncated = true;
            fields.push(change);
        }
        if (fields.length)
            changed.push({ locale, fields });
        else
            unchangedLocales++;
    }
    const localesAdded = [...to.keys()].filter((l) => !from.has(l)).sort();
    const localesRemoved = [...from.keys()].filter((l) => !to.has(l)).sort();
    return { changed, localesAdded, localesRemoved, unchangedLocales };
}
async function localizationsOf(http, versionId, locale) {
    const { items } = await http.collect(`/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations`, {
        'fields[appStoreVersionLocalizations]': ['locale', ...COMPARED_FIELDS].join(','),
        limit: 200,
    }, 5);
    const map = new Map();
    for (const item of items) {
        const attrs = item?.attributes ?? {};
        const key = String(attrs.locale ?? '');
        if (!key)
            continue;
        if (locale && key.toLowerCase() !== locale.toLowerCase())
            continue;
        map.set(key, attrs);
    }
    return map;
}
export async function executeMetadataTool(name, args, ctx) {
    if (name !== 'listing__diff_metadata') {
        throw new Error(`Unknown metadata tool: ${name}`);
    }
    if (!args.app || typeof args.app !== 'string') {
        throw new AscApiError('"app" is required.', 0);
    }
    const http = ctx.http;
    const app = await resolveApp(http, String(args.app));
    const res = await http.get(`/v1/apps/${encodeURIComponent(app.id)}/appStoreVersions`, {
        'fields[appStoreVersions]': 'versionString,appStoreState,createdDate',
        limit: 40,
    });
    const all = (res?.data ?? []).map((v) => ({
        id: String(v.id),
        version: String(v.attributes?.versionString ?? ''),
        appStoreState: String(v.attributes?.appStoreState ?? 'UNKNOWN'),
    }));
    if (all.length === 0) {
        throw new AscApiError(`${app.name} has no App Store versions to compare.`, 0);
    }
    const byName = (want) => {
        const hit = all.find((v) => v.version === want);
        if (!hit) {
            throw new AscApiError(`${app.name} has no version "${want}". Found: ${all.map((v) => v.version).join(', ')}.`, 0);
        }
        return hit;
    };
    const wantFrom = args.from ? String(args.from).trim() : undefined;
    const wantTo = args.to ? String(args.to).trim() : undefined;
    // Apple returns versions newest first, so "the one being prepared" is the
    // newest that is not live and "the one on sale" is the newest that is.
    const live = all.find((v) => LIVE_STATES.has(v.appStoreState));
    const pending = all.find((v) => !LIVE_STATES.has(v.appStoreState));
    const from = wantFrom ? byName(wantFrom) : live;
    const to = wantTo ? byName(wantTo) : pending;
    if (!from || !to) {
        throw new AscApiError(!from
            ? `${app.name} has no version on sale to compare against. Name one with "from": ${all.map((v) => v.version).join(', ')}.`
            : `${app.name} has no version being prepared. Name one with "to": ${all.map((v) => v.version).join(', ')}.`, 0);
    }
    if (from.id === to.id) {
        throw new AscApiError(`"from" and "to" are the same version (${from.version}). Name two different versions.`, 0);
    }
    const locale = args.locale ? String(args.locale).trim() : undefined;
    const [beforeMap, afterMap] = await Promise.all([
        localizationsOf(http, from.id, locale),
        localizationsOf(http, to.id, locale),
    ]);
    if (locale && beforeMap.size === 0 && afterMap.size === 0) {
        throw new AscApiError(`Neither version has a "${locale}" localization. Omit "locale" to see which locales exist.`, 0);
    }
    const diff = diffLocalizations(beforeMap, afterMap);
    return {
        app: `${app.name} (${app.id})`,
        from: { version: from.version, appStoreState: from.appStoreState },
        to: { version: to.version, appStoreState: to.appStoreState },
        identical: diff.changed.length === 0 &&
            diff.localesAdded.length === 0 &&
            diff.localesRemoved.length === 0,
        ...diff,
    };
}
//# sourceMappingURL=metadata.js.map