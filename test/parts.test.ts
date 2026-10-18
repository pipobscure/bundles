import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as CRYPTO from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { install, update, uninstall, installed, records, partsOf, pathOf, installDir, appsDir, recordPath, desktopSetupWanted, commit } from '../src/install.ts';
import { pinOf, checkIntegrity } from '../src/integrity.ts';
import { verifyBundleSync } from '../src/api.ts';
import { scopeDir, pluginsDir } from '../src/scopes.ts';
import { list } from '../src/plugins.ts';
import { main } from '../src/cli.ts';
import { ROOT_PEM, WINDOWS, build, collector, scratch, tree } from './helpers.ts';

// An app made of parts: archives that ship beside it, pinned by hash in its
// package.json, installed as plugins in its scope, and trusted because the
// app is. Against a server in this process, serving real archives.

const tmp = scratch('parts');
const HOME = PATH.join(tmp, 'home');
FS.mkdirSync(HOME, { recursive: true });
process.env['HOME'] = HOME;
process.env['BUNDLE_INSTALL_DIR'] = PATH.join(HOME, 'bin');
process.env['BUNDLE_PLUGINS'] = PATH.join(HOME, 'plugins');
process.env['BUNDLE_APPS'] = PATH.join(HOME, 'apps');
process.env['XDG_DATA_HOME'] = PATH.join(HOME, '.local', 'share');
process.env['XDG_STATE_HOME'] = PATH.join(HOME, 'state');
process.env['XDG_CONFIG_HOME'] = PATH.join(HOME, '.config');
process.env['LOCALAPPDATA'] = PATH.join(HOME, 'AppData');
process.env['BUNDLE_NO_DESKTOP_SETUP'] = '1';
process.env['BUNDLE_NO_WINDOWS_SETUP'] = '1';
process.env['BUNDLE_SYSTEM_POLICY'] = PATH.join(HOME, 'no-system-policy.json');
process.env['BUNDLE_POLICY'] = PATH.join(HOME, 'policy.json');
process.env['BUNDLE_SYSTEM_ROOT'] = PATH.join(tmp, 'machine');
delete process.env['BUNDLE_ROOT'];
FS.writeFileSync(process.env['BUNDLE_POLICY'], JSON.stringify({ discovery: false }));
const options = { roots: [ROOT_PEM], associate: false, discover: false };

/** What the server serves, by path. */
const served = new Map<string, { bytes: Buffer; etag: string }>();
const asked: string[] = [];
const server: Server = createServer((req, res) => {
    asked.push(req.url ?? '');
    const found = served.get(req.url ?? '');
    if (!found) return void res.writeHead(404).end();
    if (req.headers['if-none-match'] === found.etag) return void res.writeHead(304).end();
    res.writeHead(200, { 'content-type': 'application/zip', etag: found.etag }).end(found.bytes);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
test.after(() => {
    server.close();
    FS.rmSync(tmp, { recursive: true, force: true });
});

let made = 0;
/** A part: an unsigned archive holding a package, which says `tag`. */
async function part(pkg: string, tag: string): Promise<string> {
    const n = ++made;
    const dir = tree(tmp, {
        'package.json': JSON.stringify({ name: pkg, version: '1.0.0', type: 'module', exports: './index.js', ordner: { section: tag } }),
        'index.js': `export default ${JSON.stringify(tag)};`,
    }, `part-${n}`);
    return await build(dir, PATH.join(tmp, `part-${n}.nzip`), { signed: false, files: ['package.json', 'index.js'] });
}

/** An app, signed, declaring `parts` — as `{ package, url, hash }` — in its package.json. */
async function host(pkg: string, parts: { package: string; url: string; hash: string }[], tag = 'v1'): Promise<string> {
    const n = ++made;
    const dir = tree(tmp, {
        'package.json': JSON.stringify({ name: pkg, type: 'module', main: 'index.js', bundle: { parts } }),
        'index.js': `console.log(${JSON.stringify(tag)});`,
    }, `host-${n}`);
    return await build(dir, PATH.join(tmp, `host-${n}.nzip`), { files: ['package.json', 'index.js'] });
}

/** Serve `file` at `path`. */
function serve(path: string, file: string, etag = `"${CRYPTO.randomUUID()}"`): void {
    served.set(path, { bytes: FS.readFileSync(file), etag });
}

const sha256 = (file: string) => CRYPTO.createHash('sha256').update(FS.readFileSync(file)).digest('hex');
const SCOPE = '@acme/suite';
const APP = WINDOWS ? 'suite.nzip' : 'suite';
const at = (pkg: string) => PATH.join(scopeDir(SCOPE), ...`${pkg}.nzip`.split('/'));

// Every archive is built before the first test runs.
const a1 = await part('@acme/auth', 'auth one');
const b1 = await part('@acme/mail', 'mail one');
const v1 = await host(SCOPE, [
    { package: '@acme/auth', url: 'auth.nzip', hash: pinOf(a1)! },
    { package: '@acme/mail', url: 'parts/mail.nzip', hash: pinOf(b1)! },
]);

const running1 = await host('@acme/running', [{ package: '@acme/auth', url: 'auth.nzip', hash: pinOf(a1)! }], 'running one');
const a2 = await part('@acme/auth', 'auth two');
const c2 = await part('@acme/scan', 'scan two');
const v2 = await host(SCOPE, [
    { package: '@acme/auth', url: 'auth.nzip', hash: pinOf(a2)! },
    { package: '@acme/scan', url: 'scan.nzip', hash: pinOf(c2)! },
], 'v2');
const running2 = await host('@acme/running', [{ package: '@acme/auth', url: 'auth2.nzip', hash: pinOf(a2)! }], 'running two');

test('a part is pinned by its whole-file hash: what attestations name, not the sha256 of the file', async () => {
    const file = await part('@acme/pinned', 'pinned');
    const pin = pinOf(file);
    assert.equal(pin, `sha256:${verifyBundleSync(file, { integrity: true }).hash}`, 'what verify reports');
    assert.notEqual(pin, `sha256:${sha256(file)}`, 'the file\'s own sha256 also covers the trailing comment');
    assert.deepEqual({ ok: checkIntegrity(file).ok, pin: checkIntegrity(file).pin }, { ok: true, pin });

    const io = collector();
    assert.equal(await main(['parts', '--base', tmp, file], io), 0);
    assert.deepEqual(JSON.parse(io.stdout.join('\n')), [{ package: '@acme/pinned', url: PATH.basename(file), hash: pin }]);

    const manifest = PATH.join(tmp, 'write-to.json');
    FS.writeFileSync(manifest, `${JSON.stringify({ name: SCOPE, version: '1.0.0', bundle: { app: { title: 'Suite' } } }, null, 4)}\n`);
    assert.equal(await main(['parts', '--write', manifest, file], collector()), 0);
    assert.deepEqual(JSON.parse(FS.readFileSync(manifest, 'utf-8')), {
        name: SCOPE, version: '1.0.0', bundle: { app: { title: 'Suite' }, parts: [{ package: '@acme/pinned', url: PATH.basename(file), hash: pin }] },
    }, 'into bundle.parts, and nothing else touched');
    assert.match(FS.readFileSync(manifest, 'utf-8'), /^ {4}"name"/m, 'in the indentation the file had');

    const broken = PATH.join(tmp, 'broken.nzip');
    FS.writeFileSync(broken, FS.readFileSync(file).subarray(0, 100));
    const failed = collector();
    assert.equal(await main(['parts', broken], failed), 70);
    assert.match(failed.stderr.join('\n'), /does not hold together/);
});


test('an app installs its parts from beside it, each held to its pin, as plugins in its scope', async () => {
    serve('/suite/suite.nzip', v1, '"v1"');
    serve('/suite/auth.nzip', a1);
    serve('/suite/parts/mail.nzip', b1);
    const record = await install(`${BASE}/suite/suite.nzip`, options);
    assert.equal(record.name, APP);
    assert.equal(record.package, SCOPE);

    const parts = partsOf(APP);
    assert.deepEqual(parts.map(({ name, partOf, hash, url }) => ({ name, partOf, hash, url })), [
        { name: `${SCOPE}:@acme/auth`, partOf: APP, hash: pinOf(a1), url: `${BASE}/suite/auth.nzip` },
        { name: `${SCOPE}:@acme/mail`, partOf: APP, hash: pinOf(b1), url: `${BASE}/suite/parts/mail.nzip` },
    ], 'each url resolved against the app\'s');
    assert.deepEqual(FS.readFileSync(at('@acme/auth')), FS.readFileSync(a1));
    assert.deepEqual(list(SCOPE).map(({ package: pkg, manifest }) => [pkg, (manifest['ordner'] as { section: string }).section]),
        [['@acme/auth', 'auth one'], ['@acme/mail', 'mail one']], 'what the host reads of them, custom fields included');

    const checks = new Map(installed().map((check) => [check.record.name, check]));
    assert.equal(checks.get(APP)?.state, 'ok');
    assert.equal(checks.get(`${SCOPE}:@acme/auth`)?.state, 'ok');
    assert.match(checks.get(`${SCOPE}:@acme/auth`)!.reason, new RegExp(`pinned by ${APP}: sha256:`));
});

test('a part that is not what its app pins refuses the app, and nothing is installed', async () => {
    const real = await part('@acme/other-part', 'real');
    const wrong = await part('@acme/other-part', 'not the one pinned');
    const other = await host('@acme/other', [{ package: '@acme/other-part', url: 'p.nzip', hash: pinOf(real)! }]);
    serve('/other/other.nzip', other);
    serve('/other/p.nzip', wrong);
    const before = FS.readFileSync(recordPath(), 'utf-8');
    await assert.rejects(install(`${BASE}/other/other.nzip`, options),
        (err: Error & { code?: string }) => err.code === 'ERR_BUNDLE_UNTRUSTED' && new RegExp(`its part @acme/other-part, from .*, has the whole-file hash sha256:\\w+, and ${WINDOWS ? 'other\\.nzip' : 'other'} pins sha256:`).test(err.message));
    assert.equal(FS.readFileSync(recordPath(), 'utf-8'), before, 'no record');
    assert.equal(FS.existsSync(scopeDir('@acme/other')), false, 'no part');
    assert.equal(FS.existsSync(PATH.join(installDir(), WINDOWS ? 'other.nzip' : 'other')), false, 'and no app');

    // Somewhere else than the app is fetched from, by other means, is not where a part is.
    const elsewhere = await host('@acme/elsewhere', [{ package: '@acme/other-part', url: pathToFileURL(real).href, hash: pinOf(real)! }]);
    serve('/elsewhere.nzip', elsewhere);
    await assert.rejects(install(`${BASE}/elsewhere.nzip`, options), /parts are fetched as their app is, over http/);
});


test('an update brings the parts in step, and says what became of each', async () => {
    serve('/suite/suite.nzip', v2, '"v2"');
    serve('/suite/auth.nzip', a2);
    serve('/suite/scan.nzip', c2);
    const results = await update(APP, options);
    const said = Object.fromEntries(results.map(({ record, state, partOf, hash, previousHash }) => [record.name, { state, partOf, hash, previousHash }]));
    assert.deepEqual(said, {
        [APP]: { state: 'updated', partOf: undefined, hash: verifyHash(v2), previousHash: verifyHash(v1) },
        [`${SCOPE}:@acme/auth`]: { state: 'updated', partOf: APP, hash: pinOf(a2), previousHash: pinOf(a1) },
        [`${SCOPE}:@acme/scan`]: { state: 'added', partOf: APP, hash: pinOf(c2), previousHash: undefined },
        [`${SCOPE}:@acme/mail`]: { state: 'removed', partOf: APP, hash: undefined, previousHash: pinOf(b1) },
    }, 'what a host needs to know which services to restart');
    assert.equal(FS.existsSync(at('@acme/mail')), false, 'a part the app no longer has is gone');
    assert.deepEqual(FS.readFileSync(at('@acme/auth')), FS.readFileSync(a2));
    assert.deepEqual(partsOf(APP).map(({ package: pkg }) => pkg), ['@acme/auth', '@acme/scan']);

    // Asked again: the app is unchanged, by its ETag, and so is every part.
    const again = await update(APP, options);
    assert.deepEqual(again.map(({ record, state }) => [record.name, state]),
        [[APP, 'unchanged'], [`${SCOPE}:@acme/auth`, 'unchanged'], [`${SCOPE}:@acme/scan`, 'unchanged']]);
    // Naming a part updates its app.
    assert.equal((await update(`${SCOPE}:@acme/scan`, options))[0]!.record.name, APP);
});

function verifyHash(file: string): string {
    return `sha256:${verifyBundleSync(file, { integrity: true }).hash}`;
}

test('an update that cannot have every part changes nothing: the app, its parts and the records stay as they were', async () => {
    const a3 = await part('@acme/auth', 'auth three');
    const c3 = await part('@acme/scan', 'scan three');
    const v3 = await host(SCOPE, [
        { package: '@acme/auth', url: 'auth.nzip', hash: pinOf(a3)! },
        { package: '@acme/scan', url: 'scan.nzip', hash: 'sha256:' + '0'.repeat(64) },
    ], 'v3');
    const before = { records: FS.readFileSync(recordPath(), 'utf-8'), app: sha256(pathOf(records()[APP]!)), auth: sha256(at('@acme/auth')), scan: sha256(at('@acme/scan')) };
    serve('/suite/suite.nzip', v3, '"v3"');
    serve('/suite/auth.nzip', a3);
    serve('/suite/scan.nzip', c3);
    const [result, ...rest] = await update(APP, options);
    assert.equal(result!.state, 'refused');
    assert.match(result!.reason!, /its part @acme\/scan, from .*, has the whole-file hash .* pins sha256:0{64}/);
    assert.deepEqual(rest, [], 'no part moved');
    assert.deepEqual({ records: FS.readFileSync(recordPath(), 'utf-8'), app: sha256(pathOf(records()[APP]!)), auth: sha256(at('@acme/auth')), scan: sha256(at('@acme/scan')) },
        before, 'the new auth part, fetched and good, was never put in place');
    assert.equal(FS.readdirSync(PATH.dirname(at('@acme/auth'))).filter((name) => /incoming|previous/.test(name)).length, 0, 'and nothing was left behind');

    // A part that cannot be fetched at all, the same.
    served.delete('/suite/scan.nzip');
    const v4 = await host(SCOPE, [{ package: '@acme/auth', url: 'auth.nzip', hash: pinOf(a3)! }, { package: '@acme/scan', url: 'scan.nzip', hash: pinOf(c3)! }], 'v4');
    serve('/suite/suite.nzip', v4, '"v4"');
    const [failed] = await update(APP, options);
    assert.equal(failed!.state, 'failed');
    assert.match(failed!.reason!, /its part @acme\/scan, at .*scan\.nzip: 404/);
    assert.equal(sha256(at('@acme/auth')), before.auth);
    // Served as installed again, for what follows.
    serve('/suite/suite.nzip', v2, '"v2"');
    serve('/suite/auth.nzip', a2);
    serve('/suite/scan.nzip', c2);
});

test('a part is checked against its app: its file, the app\'s pin, and the app still vouched for', async () => {
    const auth = `${SCOPE}:@acme/auth`;
    const state = () => new Map(installed().map((check) => [check.record.name, check]));
    const original = FS.readFileSync(at('@acme/auth'));
    FS.writeFileSync(at('@acme/auth'), Buffer.concat([original, Buffer.from('x')]));
    assert.equal(state().get(auth)?.state, 'changed');
    // The app is unchanged; the part that is not what was installed is fetched again.
    const repaired = await update(APP, options);
    assert.deepEqual(repaired.map(({ record, state: what }) => [record.name, what]),
        [[APP, 'unchanged'], [auth, 'updated'], [`${SCOPE}:@acme/scan`, 'unchanged']]);
    assert.deepEqual(FS.readFileSync(at('@acme/auth')), original);
    assert.equal(state().get(auth)?.state, 'ok');

    const app = pathOf(records()[APP]!);
    const bytes = FS.readFileSync(app);
    FS.writeFileSync(app, Buffer.concat([bytes, Buffer.from('x')]));
    try {
        const checks = state();
        assert.equal(checks.get(APP)?.state, 'changed');
        assert.equal(checks.get(auth)?.state, 'valid-untrusted');
        assert.match(checks.get(auth)!.reason, new RegExp(`pinned by ${APP}, which is not vouched for`));
    } finally {
        FS.writeFileSync(app, bytes);
    }
});

test('a part goes with its app, and never by itself', async () => {
    assert.throws(() => uninstall(`${SCOPE}:@acme/auth`), new RegExp(`is a part of ${APP}, and goes when it does`));
    serve('/lone.nzip', a2);
    await assert.rejects(install(`${BASE}/lone.nzip`, { ...options, scope: SCOPE }), new RegExp(`is a part of ${APP}`));
    const gone = uninstall(APP);
    assert.deepEqual(gone.plugins.map(({ name }) => name).sort(), [`${SCOPE}:@acme/auth`, `${SCOPE}:@acme/scan`]);
    assert.deepEqual(partsOf(APP), []);
    assert.equal(FS.existsSync(scopeDir(SCOPE)), false, 'and its scope with them');
});

test('an app installs from a file, finding its parts beside it — and from bytes, as the URL they stand for', async () => {
    const dir = PATH.join(tmp, 'usb-stick');
    FS.mkdirSync(PATH.join(dir, 'parts'), { recursive: true });
    FS.copyFileSync(v1, PATH.join(dir, 'suite.nzip'));
    FS.copyFileSync(a1, PATH.join(dir, 'auth.nzip'));
    FS.copyFileSync(b1, PATH.join(dir, 'parts', 'mail.nzip'));
    const record = await install(PATH.join(dir, 'suite.nzip'), options);
    assert.equal(record.name, APP);
    assert.equal(record.url, pathToFileURL(PATH.join(dir, 'suite.nzip')).href);
    assert.deepEqual(partsOf(APP).map(({ url }) => url), [pathToFileURL(PATH.join(dir, 'auth.nzip')).href, pathToFileURL(PATH.join(dir, 'parts', 'mail.nzip')).href]);
    // An update reads the file again.
    assert.deepEqual((await update(APP, options)).map(({ state }) => state), ['unchanged', 'unchanged', 'unchanged']);
    uninstall(APP);

    asked.length = 0;
    serve('/mirror/auth.nzip', a1);
    serve('/mirror/parts/mail.nzip', b1);
    const fromBytes = await install({ bytes: FS.readFileSync(v1), name: APP, source: `${BASE}/mirror/suite.nzip` }, options);
    assert.equal(fromBytes.url, `${BASE}/mirror/suite.nzip`);
    assert.deepEqual(asked, ['/mirror/auth.nzip', '/mirror/parts/mail.nzip'], 'only its parts were fetched, against the source');
    uninstall(APP);

    await assert.rejects(install({ bytes: FS.readFileSync(v1), name: APP }, options), /give the URL it stands for/);
    const io = collector();
    assert.equal(await main(['install', '--source', `${BASE}/mirror/suite.nzip`, '--yes', '--root', ROOT_PEM, '--no-discover', PATH.join(dir, 'suite.nzip')], io), 0, io.stderr.join('\n'));
    assert.equal(records()[APP]?.url, `${BASE}/mirror/suite.nzip`);
    uninstall(APP);
});

test('BUNDLE_ROOT puts everything under one root, and --system is the machine\'s', async () => {
    const saved = Object.fromEntries(['BUNDLE_INSTALL_DIR', 'BUNDLE_PLUGINS', 'BUNDLE_APPS', 'BUNDLE_NO_DESKTOP_SETUP'].map((name) => [name, process.env[name]]));
    const root = process.env['BUNDLE_SYSTEM_ROOT']!;
    for (const name of Object.keys(saved)) delete process.env[name];
    try {
        serve('/suite/suite.nzip', v1, '"v1-again"');
        serve('/suite/auth.nzip', a1);
        serve('/suite/parts/mail.nzip', b1);
        const io = collector();
        assert.equal(await main(['install', '--system', '--yes', '--root', ROOT_PEM, '--no-discover', `${BASE}/suite/suite.nzip`], io), 0, io.stderr.join('\n'));
        assert.equal(process.env['BUNDLE_ROOT'], undefined, 'for that command only');

        process.env['BUNDLE_ROOT'] = root;
        assert.deepEqual({ bin: installDir(), apps: appsDir(), plugins: pluginsDir(), state: PATH.dirname(recordPath()) },
            { bin: PATH.join(root, 'bin'), apps: PATH.join(root, 'apps'), plugins: PATH.join(root, 'plugins'), state: PATH.join(root, 'state') });
        assert.equal(desktopSetupWanted(), false, 'a root has no desktop');
        assert.ok(records()[APP], 'recorded under the root');
        assert.ok(FS.existsSync(PATH.join(root, 'plugins', '@acme', 'suite', '@acme', 'auth.nzip')));
        if (!WINDOWS) assert.equal(FS.realpathSync(PATH.join(root, 'bin', APP)), FS.realpathSync(PATH.join(root, 'apps', 'suite.nzip')));
        delete process.env['BUNDLE_ROOT'];

        // Without a root of its own, a process finds a scope the machine has
        // when its user has none — never a mix of the two.
        assert.deepEqual(records()[APP], undefined, 'the user\'s records are their own');
        assert.equal(scopeDir(SCOPE), PATH.join(root, 'plugins', '@acme', 'suite'));
        assert.deepEqual(list(SCOPE).map(({ package: pkg }) => pkg), ['@acme/auth', '@acme/mail']);
        const own = PATH.join(pluginsDir(), '@acme', 'suite');
        FS.mkdirSync(own, { recursive: true });
        assert.equal(scopeDir(SCOPE), own, 'the user\'s, once they have one');
        assert.equal(scopeDir(SCOPE, { fallback: false }), own);
        FS.rmSync(own, { recursive: true });

        const listed = collector();
        assert.equal(await main(['installed', '--system', '--json'], listed), 0, listed.stderr.join('\n'));
        assert.deepEqual((JSON.parse(listed.stdout.join('\n')) as { name: string; partOf?: string }[]).map(({ name, partOf }) => [name, partOf]),
            [[`${SCOPE}:@acme/auth`, APP], [`${SCOPE}:@acme/mail`, APP], [APP, undefined]]);
        assert.equal(await main(['uninstall', '--system', APP], collector()), 0);
        assert.equal(FS.existsSync(PATH.join(root, 'plugins', '@acme', 'suite')), false);
    } finally {
        delete process.env['BUNDLE_ROOT'];
        for (const [name, value] of Object.entries(saved)) if (value !== undefined) process.env[name] = value;
    }
});

test('files are put in place whether or not something has them open, either way the platform allows', () => {
    for (const aside of [false, true]) {
        const dir = PATH.join(tmp, `commit-${aside}`);
        FS.mkdirSync(dir, { recursive: true });
        const [one, two, gone] = ['one.nzip', 'two.nzip', 'gone.nzip'].map((name) => PATH.join(dir, name)) as [string, string, string];
        FS.writeFileSync(one, 'old one');
        FS.writeFileSync(gone, 'to go');
        const held = FS.openSync(one, 'r');
        try {
            commit([{ target: one, bytes: Buffer.from('new one'), mode: 0o644 }, { target: two, bytes: Buffer.from('new two'), mode: 0o644 }], [gone], { aside });
            const read = Buffer.alloc(7);
            FS.readSync(held, read, 0, 7, 0);
            assert.equal(read.toString(), 'old one', 'whoever had it open still reads what they opened');
        } finally {
            FS.closeSync(held);
        }
        assert.deepEqual([FS.readFileSync(one, 'utf-8'), FS.readFileSync(two, 'utf-8'), FS.existsSync(gone)], ['new one', 'new two', false]);
        // Left behind, as one still open would be on Windows: the next commit takes it away.
        FS.writeFileSync(`${one}.previous-1`, 'stale');
        commit([{ target: one, bytes: Buffer.from('newer'), mode: 0o644 }], [], { aside });
        assert.deepEqual(FS.readdirSync(dir).sort(), ['one.nzip', 'two.nzip'], `nothing left over (aside: ${aside})`);
    }
});

test('a rename that fails part way puts back everything before it, either way', () => {
    for (const aside of [false, true]) {
        for (let failing = 1; failing <= (aside ? 5 : 3); failing++) {
            const dir = PATH.join(tmp, `rollback-${aside}-${failing}`);
            FS.mkdirSync(dir, { recursive: true });
            const [one, two, fresh, gone] = ['one.nzip', 'two.nzip', 'fresh.nzip', 'gone.nzip'].map((name) => PATH.join(dir, name)) as [string, string, string, string];
            FS.writeFileSync(one, 'old one');
            FS.writeFileSync(two, 'old two');
            FS.writeFileSync(gone, 'to go');
            let calls = 0;
            const rename = (from: string, to: string) => {
                if (++calls === failing) throw Object.assign(new Error('refused'), { code: 'EPERM' });
                FS.renameSync(from, to);
            };
            assert.throws(() => commit([
                { target: one, bytes: Buffer.from('new one'), mode: 0o644 },
                { target: fresh, bytes: Buffer.from('fresh'), mode: 0o644 },
                { target: two, bytes: Buffer.from('new two'), mode: 0o644 },
            ], [gone], { aside, rename }), { code: 'EPERM' });
            assert.deepEqual(Object.fromEntries(FS.readdirSync(dir).sort().map((name) => [name, FS.readFileSync(PATH.join(dir, name), 'utf-8')])),
                { 'gone.nzip': 'to go', 'one.nzip': 'old one', 'two.nzip': 'old two' }, `as it was, after rename ${failing} failed (aside: ${aside})`);
        }
    }
});

test('an app and its parts update while the app runs and a part is loaded', async () => {
    serve('/running/running.nzip', running1, '"r1"');
    serve('/running/auth.nzip', a1);
    const record = await install(`${BASE}/running/running.nzip`, options);
    const archive = pathOf(record);
    const loaded = PATH.join(scopeDir('@acme/running'), '@acme', 'auth.nzip');

    // The app, running from its archive, as a launcher runs it; and its part, open.
    const app = spawn(process.execPath, ['--no-warnings', '--experimental-vfs', '--vfs-load', archive, '-e',
        "setInterval(() => {}, 1000); console.log('running');"], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => app.stdout.once('data', () => resolve()));
    const part = (await import('node:zlib')).ZipFile.openSync(loaded);
    try {
        serve('/running/running.nzip', running2, '"r2"');
        serve('/running/auth2.nzip', a2);
        const results = await update(record.name, options);
        assert.deepEqual(results.map(({ state, reason }) => [state, reason]), [['updated', undefined], ['updated', undefined]]);
        assert.deepEqual(FS.readFileSync(archive), FS.readFileSync(running2), 'the app\'s archive is the new one');
        assert.deepEqual(FS.readFileSync(loaded), FS.readFileSync(a2), 'and so is its part');
        assert.match(part.getSync('index.js').contentSync().toString(), /auth one/, 'what was loaded goes on reading the old one');
        assert.equal(app.exitCode, null, 'and the app goes on running');
    } finally {
        part.closeSync();
        app.kill();
        await new Promise((resolve) => app.once('exit', resolve));
    }
    uninstall(record.name);
    assert.deepEqual(FS.readdirSync(PATH.dirname(archive)).filter((name) => name.includes('.previous-')), [], 'the old archive, once closed, is gone too');
});
