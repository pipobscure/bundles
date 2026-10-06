import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import {
    FILE_KEYS, RULE_KEYS, REQUIRE_KEYS, TRUST_KEYS, SIGNER_KEYS, FINGERPRINT_PATTERN, DISCOVERY_PATTERN,
    readPolicyFile, formatPolicyFile, starterPolicy, schemaUrl,
} from '../src/policy.ts';
import { DID_PATTERN, ATTESTER_PATTERN, DURATION_PATTERN } from '../src/attestation.ts';
import { packageVersion } from '../src/files.ts';
import { main } from '../src/cli.ts';
import { releasedSchema, SOURCE } from '../tools/schema.ts';
import { collector, scratch } from './helpers.ts';

// The JSON Schema for policy files, and the checker installs use, must say the
// same thing about every file — or an editor would bless a file that `bundle`
// refuses, or flag one it accepts. These tests hold the two together: the same
// keys, the same patterns, and the same verdict on a set of real documents.

const tmp = scratch('policy');
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

type Schema = Record<string, unknown> & {
    $defs: Record<string, Schema>;
    properties?: Record<string, Schema>;
};
const schema = JSON.parse(FS.readFileSync(SOURCE, 'utf-8')) as Schema;

function resolve(node: Schema): Schema {
    const ref = node['$ref'];
    return typeof ref === 'string' ? resolve(schema.$defs[ref.replace('#/$defs/', '')]!) : node;
}

// Enough of JSON Schema 2020-12 for what this schema uses. Annotations
// (`format`, `default`, `examples`, descriptions) are ignored, as a validator
// does by default.
function valid(value: unknown, node: Schema = schema): boolean {
    node = resolve(node);
    if ('const' in node && value !== node['const']) return false;
    if (Array.isArray(node['anyOf']) && !(node['anyOf'] as Schema[]).some((each) => valid(value, each))) return false;
    const type = node['type'];
    if (type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const object = value as Record<string, unknown>;
        const properties = node.properties ?? {};
        for (const key of (node['required'] as string[] | undefined) ?? []) if (!(key in object)) return false;
        for (const [key, needs] of Object.entries((node['dependentRequired'] as Record<string, string[]> | undefined) ?? {})) {
            if (key in object && needs.some((need) => !(need in object))) return false;
        }
        const names = node['propertyNames'] as Schema | undefined;
        for (const [key, item] of Object.entries(object)) {
            if (names && !valid(key, { ...names, type: 'string' } as Schema)) return false;
            if (key in properties) {
                if (!valid(item, properties[key]!)) return false;
            } else if (node['additionalProperties'] === false) {
                return false;
            } else if (node['additionalProperties'] && !valid(item, node['additionalProperties'] as Schema)) {
                return false;
            }
        }
        return true;
    }
    if (type === 'array') {
        if (!Array.isArray(value)) return false;
        if (node['uniqueItems'] && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return false;
        if (typeof node['minItems'] === 'number' && value.length < node['minItems']) return false;
        return value.every((item) => valid(item, node['items'] as Schema));
    }
    if (type === 'string') {
        if (typeof value !== 'string') return false;
        if (typeof node['minLength'] === 'number' && value.length < node['minLength']) return false;
        return typeof node['pattern'] !== 'string' || new RegExp(node['pattern'], 'u').test(value);
    }
    if (type === 'boolean') return typeof value === 'boolean';
    if (type === 'integer') return Number.isInteger(value) && (typeof node['minimum'] !== 'number' || (value as number) >= node['minimum']);
    return true;
}

// What `bundle` itself says about a document.
function accepted(document: unknown): boolean {
    const file = PATH.join(tmp, 'candidate.json');
    FS.writeFileSync(file, JSON.stringify(document));
    try {
        readPolicyFile(file);
        return true;
    } catch {
        return false;
    }
}

const DID = 'did:web:audit.example.com';
const PLC = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
const FINGERPRINT = Array.from({ length: 32 }, () => 'AB').join(':');

const VALID: unknown[] = [
    {},
    { $schema: schemaUrl('1.2.3') },
    starterPolicy(),
    {
        require: { signature: true, sameIssuer: true, attesters: [`audited@${DID}`, PLC], quorum: 1 },
        issuers: ['https://token.actions.githubusercontent.com'],
        trust: {
            signers: [{ identity: 'https://github.com/o/r/.github/workflows/release.yml@refs/heads/main', issuer: 'https://token.actions.githubusercontent.com' }],
            attesters: [DID, `reproduced@${PLC}`],
            certificates: [FINGERPRINT],
        },
        block: [PLC],
        ignore: [DID],
        discovery: 'https://constellation.microcosm.blue',
        maxAge: '12h',
        apps: { pnpm: { require: { sameIssuer: true }, trust: { attesters: [DID] }, block: [PLC] } },
    },
    { discovery: false },
    { maxAge: '90' },
    { require: { attesters: [] } },
];

const INVALID: unknown[] = [
    [],
    'policy',
    { requires: {} },                                          // a typo
    { $schema: 7 },
    { require: { signature: 'yes' } },
    { require: { quorum: 1 } },                                 // a quorum of nobody
    { require: { attesters: ['alice.example.com'] } },          // a handle, not a DID
    { require: { attesters: [DID, DID] } },                     // twice
    { require: { attesters: [DID], quorum: 0 } },
    { require: { attesters: [DID], quorum: 1.5 } },
    { require: { unknown: true } },
    { issuers: [''] },
    { trust: { signers: [{ identity: 'x' }] } },                // no issuer
    { trust: { signers: [{ identity: 'x', issuer: 'y', extra: 1 }] } },
    { trust: { certificates: ['AB:CD'] } },
    { block: [`malware@${PLC}`] },                              // block takes DIDs
    { ignore: ['did:key:z6Mk'] },                               // a DID method atproto does not use
    { discovery: 'ftp://index.example' },
    { discovery: true },
    { maxAge: 'a week' },
    { apps: { '': {} } },
    { apps: { pnpm: { discovery: false } } },                   // global-only settings
    { apps: { pnpm: [] } },
];

test('the schema and the checker agree on every document', () => {
    for (const document of VALID) {
        assert.equal(accepted(document), true, `bundle refuses ${JSON.stringify(document)}`);
        assert.equal(valid(document), true, `the schema refuses ${JSON.stringify(document)}`);
    }
    for (const document of INVALID) {
        assert.equal(accepted(document), false, `bundle accepts ${JSON.stringify(document)}`);
        assert.equal(valid(document), false, `the schema accepts ${JSON.stringify(document)}`);
    }
});

test('the schema lists exactly the settings the checker accepts', () => {
    const keys = (node: Schema) => Object.keys(resolve(node).properties ?? {}).sort();
    assert.deepEqual(keys(schema), [...FILE_KEYS].sort());
    assert.deepEqual(keys(schema.$defs['rules']!), [...RULE_KEYS].sort());
    assert.deepEqual(keys(schema.$defs['require']!), [...REQUIRE_KEYS].sort());
    assert.deepEqual(keys(schema.$defs['trust']!), [...TRUST_KEYS].sort());
    const signers = schema.$defs['trust']!.properties!['signers']!['items'] as Schema;
    assert.deepEqual(keys(signers), [...SIGNER_KEYS].sort());

    // Every object closes itself, so an editor flags a typo just as bundle does.
    const open: string[] = [];
    const walk = (node: unknown, where: string): void => {
        if (!node || typeof node !== 'object') return;
        const object = node as Record<string, unknown>;
        if (object['type'] === 'object' && object['additionalProperties'] === undefined) open.push(where);
        for (const [key, child] of Object.entries(object)) walk(child, `${where}/${key}`);
    };
    walk(schema, '#');
    assert.deepEqual(open, []);
});

test('the schema uses the checker\'s own patterns', () => {
    assert.equal(schema.$defs['did']!['pattern'], DID_PATTERN);
    assert.equal(schema.$defs['attester']!['pattern'], ATTESTER_PATTERN);
    assert.equal(schema.$defs['duration']!['pattern'], DURATION_PATTERN);
    const certificates = schema.$defs['trust']!.properties!['certificates']!['items'] as Schema;
    assert.equal(certificates['pattern'], FINGERPRINT_PATTERN);
    assert.equal((schema.properties!['discovery']!['anyOf'] as Schema[])[0]!['pattern'], DISCOVERY_PATTERN);
});

test('every setting is described, since the schema is the reference for writing one', () => {
    const undescribed: string[] = [];
    const walk = (node: Schema, where: string): void => {
        for (const [key, child] of Object.entries(node.properties ?? {})) {
            if (!child['description'] && !resolve(child)['description']) undescribed.push(`${where}.${key}`);
            walk(resolve(child), `${where}.${key}`);
        }
    };
    walk(schema, '');
    for (const [name, def] of Object.entries(schema.$defs)) walk(def, `$defs.${name}`);
    assert.deepEqual(undescribed, []);
    assert.equal(schema['$schema'], 'https://json-schema.org/draft/2020-12/schema');
});

test('the schema names the latest release; the released copy names its own', () => {
    assert.equal(schema['$id'], schemaUrl());
    assert.equal(schemaUrl(), 'https://github.com/pipobscure/bundles/releases/latest/download/policy.schema.json');
    const released = JSON.parse(releasedSchema('9.8.7')) as Schema;
    assert.equal(released['$id'], 'https://github.com/pipobscure/bundles/releases/download/v9.8.7/policy.schema.json');
    assert.deepEqual({ ...released, $id: schema['$id'] }, schema, 'nothing else changes');
});

test('policy files are written and shown with this version\'s schema first', async () => {
    const user = PATH.join(tmp, 'user', 'policy.json');
    const system = PATH.join(tmp, 'system', 'policy.json');
    process.env['BUNDLE_POLICY'] = user;
    process.env['BUNDLE_SYSTEM_POLICY'] = system;
    try {
        // A file that already has an older schema is shown with this one's.
        const text = formatPolicyFile({ $schema: schemaUrl('0.0.1'), block: [PLC] } as never, '1.0.0');
        assert.equal(Object.keys(JSON.parse(text) as object)[0], '$schema');
        assert.equal((JSON.parse(text) as { $schema: string }).$schema, schemaUrl('1.0.0'));

        const init = collector();
        assert.equal(await main(['policy', 'init'], init), 0);
        const written = JSON.parse(FS.readFileSync(user, 'utf-8')) as Record<string, unknown>;
        assert.equal(Object.keys(written)[0], '$schema');
        assert.equal(written['$schema'], schemaUrl(packageVersion()));
        assert.equal(valid(written), true);
        assert.equal(accepted(written), true);
        assert.equal(await main(['policy', 'init'], collector()), 70, 'never over an existing file');

        FS.mkdirSync(PATH.dirname(system), { recursive: true });
        FS.writeFileSync(system, JSON.stringify({ require: { signature: true } }));
        const shown = collector();
        assert.equal(await main(['policy', 'show'], shown), 0);
        const documents = shown.stdout.join('\n').split(/\n(?=\{)/).map((each) => JSON.parse(each) as Record<string, unknown>);
        assert.equal(documents.length, 2);
        for (const document of documents) assert.equal(document['$schema'], schemaUrl(packageVersion()));
        assert.deepEqual(documents[0]!['require'], { signature: true });

        const only = collector();
        assert.equal(await main(['policy', 'show', '--system'], only), 0);
        assert.match(only.stderr.join('\n'), new RegExp(`\\* ${system.replace(/[\\\\.]/g, '\\$&')}`));
        assert.equal(only.stdout.join('\n').split(/\n(?=\{)/).length, 1);

        const checked = collector();
        assert.equal(await main(['policy', 'check', system], checked), 0);
        FS.writeFileSync(system, JSON.stringify({ requires: {} }));
        const bad = collector();
        assert.equal(await main(['policy', 'check', system], bad), 70);
        assert.match(bad.stderr.join('\n'), /unknown setting 'requires'/);

        const summary = collector();
        FS.rmSync(system);
        assert.equal(await main(['policy'], summary), 0);
        assert.match(summary.stdout.join('\n'), new RegExp(`schema: +${schemaUrl(packageVersion()).replace(/[.]/g, '\\.')}`));
    } finally {
        delete process.env['BUNDLE_POLICY'];
        delete process.env['BUNDLE_SYSTEM_POLICY'];
    }
});
