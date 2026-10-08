import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as CRYPTO from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { use, list } from '../src/plugins.ts';
import { enforce, carriedFrom } from '../src/plugin-verifier.ts';
import { scopeDir } from '../src/scopes.ts';
import { ROOT, ROOT_PEM, CHAIN_PEM, build, scratch, tree, rewriteComment } from './helpers.ts';

// Plugins: signed bundles a host app finds by package name, through ordinary
// import and require — loaded as they are by default, and verified when the
// host or the runtime asks.
//
// Module hooks and the verifier on the global object last as long as this
// process, so the tests that do not verify come first, and every test uses a
// scope of its own.

const tmp = scratch('plugins');
process.env['BUNDLE_PLUGINS'] = PATH.join(tmp, 'plugins');
process.env['BUNDLE_ATTESTATIONS'] = PATH.join(tmp, 'attestations');
process.env['BUNDLE_SYSTEM_POLICY'] = PATH.join(tmp, 'no-system-policy.json');
const POLICY = PATH.join(tmp, 'policy.json');
process.env['BUNDLE_POLICY'] = POLICY;
for (const name of ['BUNDLE_ATTESTERS', 'BUNDLE_BLOCK', 'BUNDLE_ROOTS', 'BUNDLE_IDENTITY', 'BUNDLE_ISSUER']) delete process.env[name];
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

/** `import()` of a name only the plugins know, which the type checker cannot see. */
const dynamic = (specifier: string): Promise<unknown> => import(specifier);

const LOADER = PATH.join(ROOT, 'src', 'plugins.ts');
let made = 0;

/** A plugin archive with these files, signed with the test PKI unless told otherwise. */
async function plugin(files: Record<string, string>, { signed = true }: { signed?: boolean } = {}): Promise<string> {
    const source = tree(tmp, files, `source-${++made}`);
    return await build(source, PATH.join(tmp, `plugin-${made}.nzip`), { signed, files: Object.keys(files) });
}

/** Put `archive` into a scope's directory, as `bundle install --for` lays it out. */
function place(scope: string, name: string, archive: string): string {
    const target = PATH.join(PATH.isAbsolute(scope) ? scope : scopeDir(scope), ...`${name}.nzip`.split('/'));
    FS.mkdirSync(PATH.dirname(target), { recursive: true });
    FS.copyFileSync(archive, target);
    return target;
}

/** A host app on disk: its own dependency, and a module that imports what it is told to. */
function host(name: string, body: string): string {
    const dir = tree(tmp, {
        'package.json': JSON.stringify({ name: `${name}-host`, type: 'module' }),
        'node_modules/host-api/package.json': JSON.stringify({ name: 'host-api', type: 'module', exports: './index.js' }),
        'node_modules/host-api/index.js': `export const api = { instance: Symbol('the host api') };`,
        'main.js': body,
    }, `host-${name}`);
    return PATH.join(dir, 'main.js');
}

const ESM = {
    'package.json': JSON.stringify({ name: '@alice/gpio', type: 'module', exports: { '.': './index.js', './extra': './lib/extra.js', './pins/*': './lib/pins/*.js' } }),
    'index.js': "import { api } from 'host-api'; import { tiny } from 'tiny-dep'; export const hello = 'gpio'; export { api, tiny };",
    'lib/extra.js': "export const extra = 'extra';",
    'lib/pins/one.js': 'export default 1;',
    'node_modules/tiny-dep/package.json': JSON.stringify({ name: 'tiny-dep', type: 'module', exports: './index.js' }),
    'node_modules/tiny-dep/index.js': "export const tiny = 'bundled inside the plugin';",
};
const CJS = {
    'package.json': JSON.stringify({ name: 'cjs-thing', main: 'main.js' }),
    'main.js': "module.exports = { hello: 'cjs', api: require('host-api') };",
    'lib/x.js': "module.exports = 'x';",
};

test('a scope is a directory of its own, by package name, or any absolute path', () => {
    assert.equal(scopeDir('bled'), PATH.join(tmp, 'plugins', 'bled'));
    assert.equal(scopeDir('@acme/suite'), PATH.join(tmp, 'plugins', '@acme', 'suite'));
    assert.equal(scopeDir(tmp), tmp, 'an absolute path is itself');
    assert.throws(() => scopeDir('../escape'), /neither a package name nor an absolute path/);
});

test('use() makes a scope resolvable: import and require, subpaths, a plugin\'s own dependencies, the host\'s API', async () => {
    place('bled', '@alice/gpio', await plugin(ESM));
    place('bled', 'cjs-thing', await plugin(CJS));
    assert.deepEqual(list('bled'), ['@alice/gpio', 'cjs-thing']);

    use('bled');
    const main = host('bled', `
        import { api } from 'host-api';
        import * as gpio from '@alice/gpio';
        import { extra } from '@alice/gpio/extra';
        import one from '@alice/gpio/pins/one';
        import { createRequire } from 'node:module';
        const require = createRequire(import.meta.url);
        export const seen = { api, gpio, extra, one, cjs: require('cjs-thing'), x: require('cjs-thing/lib/x') };
    `);
    const { seen } = await import(pathToFileURL(main).href) as { seen: Record<string, any> };
    assert.equal(seen['gpio'].hello, 'gpio');
    assert.equal(seen['gpio'].tiny, 'bundled inside the plugin');
    assert.equal(seen['gpio'].api, seen['api'], 'the host\'s API, as the same instance the host has');
    assert.equal(seen['cjs'].api.api, seen['api'], 'from require too (the host\'s ES module, as require sees one)');
    assert.equal(seen['extra'], 'extra');
    assert.equal(seen['one'], 1);
    assert.equal(seen['x'], 'x');
    assert.match(String(createRequire(main).resolve('cjs-thing')), /main\.js$/);

    await assert.rejects(dynamic('@alice/gpio/lib/extra.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    await assert.rejects(dynamic('nothing-like-this'), { code: 'ERR_MODULE_NOT_FOUND' });

    // Called again, nothing happens; with other options, it says so.
    use('bled');
    assert.throws(() => use('bled', { verify: true }), /already called in this thread, with other options/);
});

test('a plugin cannot stand in for a builtin, or for anything the host already resolves', async () => {
    const dir = PATH.join(tmp, 'shadowing');
    place(dir, 'host-api', await plugin({ 'package.json': JSON.stringify({ name: 'host-api', type: 'module', exports: './i.js' }), 'i.js': "export const api = 'from a plugin';" }));
    place(dir, 'fs', await plugin({ 'package.json': JSON.stringify({ name: 'fs', main: 'i.js' }), 'i.js': "module.exports = 'from a plugin';" }));
    use(dir);
    const main = host('shadowing', `
        import { api } from 'host-api';
        import * as fs from 'fs';
        import { createRequire } from 'node:module';
        export const seen = { api, fs: fs.default, required: createRequire(import.meta.url)('fs') };
    `);
    const { seen } = await import(pathToFileURL(main).href) as { seen: { api: unknown; fs: unknown; required: unknown } };
    assert.equal(typeof seen.api, 'object', 'the host\'s own host-api');
    assert.equal(seen.fs, createRequire(import.meta.url)('node:fs'), 'the builtin, not the plugin');
    assert.equal(seen.required, createRequire(import.meta.url)('node:fs'));
});

test('a scope that cannot be indexed fails use(), and says why', async () => {
    const twice = PATH.join(tmp, 'twice');
    const archive = await plugin({ 'package.json': JSON.stringify({ name: 'same' }), 'index.js': '' });
    place(twice, 'same', archive);
    place(twice, 'other-name', archive);
    assert.throws(() => use(twice), /two plugins in .* are both 'same'/);

    const nameless = PATH.join(tmp, 'nameless');
    place(nameless, 'x', await plugin({ 'package.json': '{}', 'index.js': '' }));
    assert.throws(() => use(nameless), /its package\.json names no package/);

    assert.deepEqual(list(PATH.join(tmp, 'not-there')), [], 'a scope with nothing installed is empty');
});

test('a worker sets up its own thread, with the same use()', async () => {
    const dir = PATH.join(tmp, 'worker');
    place(dir, 'worker-plugin', await plugin({ 'package.json': JSON.stringify({ name: 'worker-plugin', type: 'module', exports: './i.js' }), 'i.js': "export default 'in a worker';" }));
    const script = PATH.join(tmp, 'worker.mjs');
    FS.writeFileSync(script, `
        import { parentPort } from 'node:worker_threads';
        let before;
        try { await import('worker-plugin'); before = 'resolved'; } catch (err) { before = err.code; }
        const { use } = await import(${JSON.stringify(pathToFileURL(LOADER).href)});
        use(${JSON.stringify(dir)});
        parentPort.postMessage({ before, after: (await import('worker-plugin')).default });
    `);
    const worker = new Worker(script);
    const answer = await new Promise((resolve, reject) => worker.once('message', resolve).once('error', reject));
    await worker.terminate();
    assert.deepEqual(answer, { before: 'ERR_MODULE_NOT_FOUND', after: 'in a worker' });
});

test('the loader needs no --experimental-vfs to load, and loads the verifier only to verify', async () => {
    // It goes into every host's bundle: what it imports is what the recording
    // run puts there, and a verifier imported statically would be in all of them.
    const dir = PATH.join(tmp, 'lazy');
    place(dir, 'lazy-one', await plugin({ 'package.json': JSON.stringify({ name: 'lazy-one' }), 'index.js': '' }, { signed: false }));
    const script = (verify: boolean) => `
        import { registerHooks } from 'node:module';
        const seen = [];
        registerHooks({ resolve: (specifier, context, next) => { const found = next(specifier, context); seen.push(found.url); return found; } });
        const { use, list } = await import(${JSON.stringify(pathToFileURL(LOADER).href)});
        const names = list(${JSON.stringify(dir)});
        const before = seen.some((url) => url.includes('plugin-verifier'));
        let refused = false;
        if (${verify}) try { use(${JSON.stringify(dir)}, { verify: true }); } catch (err) { refused = err.code === 'ERR_BUNDLE_UNTRUSTED'; }
        console.log(JSON.stringify({ names, before, after: seen.some((url) => url.includes('plugin-verifier')), refused }));`;
    const run = (flags: string[], verify: boolean) => {
        const res = spawnSync(process.execPath, ['--no-warnings', ...flags, '--input-type=module', '-e', script(verify)], { encoding: 'utf-8' });
        assert.equal(res.status, 0, res.stderr);
        return JSON.parse(res.stdout) as { names: string[]; before: boolean; after: boolean; refused: boolean };
    };
    assert.deepEqual(run([], false), { names: ['lazy-one'], before: false, after: false, refused: false }, 'no node:vfs needed to find plugins');
    assert.deepEqual(run(['--experimental-vfs'], true), { names: ['lazy-one'], before: false, after: true, refused: true });
});

// ------------------------------------------------------------- verification ---

test('verify: true refuses what nothing vouches for — every plugin, every reason, and none are loaded', async () => {
    // No verifying runtime here: the loader brings in this package's own verifier.
    const dir = PATH.join(tmp, 'verified');
    const signed = place(dir, 'signed-one', await plugin({ 'package.json': JSON.stringify({ name: 'signed-one' }), 'index.js': "module.exports = 'signed';" }));
    const unsigned = place(dir, 'unsigned-one', await plugin({ 'package.json': JSON.stringify({ name: 'unsigned-one' }), 'index.js': '' }, { signed: false }));

    let error: Error & { code?: string; refused?: { name: string; file: string; reasons: string[] }[] } | undefined;
    try {
        use(dir, { verify: true });
    } catch (err) {
        error = err as typeof error;
    }
    assert.equal(error?.code, 'ERR_BUNDLE_UNTRUSTED');
    assert.match(error!.message, /2 of 2 plugins for '.*verified' were refused, so none are loaded/);
    assert.deepEqual(error!.refused!.map(({ name, file }) => ({ name, file })), [{ name: 'signed-one', file: signed }, { name: 'unsigned-one', file: unsigned }]);
    assert.match(error!.refused![0]!.reasons[0]!, /not anchored in the trust store, and a trusted signature is required \(nothing else vouches for it\)/);
    assert.match(error!.refused![1]!.reasons[0]!, /^unsigned, and a trusted signature is required/);
    await assert.rejects(dynamic('signed-one'), { code: 'ERR_MODULE_NOT_FOUND' }, 'nothing from a refused scope is loaded');
});

test('a ca the host names anchors its plugins — and a plugin signed under another authority is refused', async () => {
    const good = PATH.join(tmp, 'ca-good');
    place(good, 'under-ca', await plugin({ 'package.json': JSON.stringify({ name: 'under-ca' }), 'index.js': "module.exports = 'anchored';" }));
    use(good, { verify: { ca: ROOT_PEM } });
    assert.equal(createRequire(PATH.join(tmp, 'x.js'))('under-ca'), 'anchored');

    // The leaf is neither the top of the chain nor what issued it.
    const leaf = new CRYPTO.X509Certificate(FS.readFileSync(CHAIN_PEM, 'utf-8')).toString();
    const wrong = PATH.join(tmp, 'ca-wrong');
    place(wrong, 'elsewhere', await plugin({ 'package.json': JSON.stringify({ name: 'elsewhere' }), 'index.js': '' }));
    assert.throws(() => use(wrong, { verify: { ca: leaf } }), /not signed under the certificate authority .* \(required by this app\)/);
});

test('what verified is what is served: a member changed after signing is refused', async () => {
    const dir = PATH.join(tmp, 'tampered');
    const file = place(dir, 'tampered', await plugin({ 'package.json': JSON.stringify({ name: 'tampered' }), 'index.js': "module.exports = 'x';" }));
    rewriteComment(file, `SIGNED:${'0'.repeat(64)}:00`);
    assert.throws(() => use(dir, { verify: { ca: ROOT_PEM } }), /archive hash does not match/);
});

test('rules come from the host, the scope\'s policy and the runtime, each named in the refusal', async () => {
    const auditor = 'did:web:audit.example';
    FS.writeFileSync(POLICY, JSON.stringify({ scopes: { policied: { block: ['did:web:scanner.example'], require: { attesters: [auditor] } } } }));
    place('policied', 'needs-audit', await plugin({ 'package.json': JSON.stringify({ name: 'needs-audit' }), 'index.js': '' }));
    try {
        use('policied', { verify: { ca: ROOT_PEM, attesters: ['did:web:other.example'] } });
        assert.fail('refused');
    } catch (err) {
        const [refused] = (err as { refused: { reasons: string[] }[] }).refused;
        const reasons = refused!.reasons.join('\n');
        assert.match(reasons, /did:web:audit\.example.*\(.*policy\.json \(scopes\.policied\)\)/);
        assert.match(reasons, /did:web:other\.example.*\(required by this app\)/);
    } finally {
        FS.rmSync(POLICY, { force: true });
    }

    // A verifying runtime verifies whatever use() says, with what carries
    // over: here, that a signature is needed — never the app's own signer.
    enforce(carriedFrom({ attesters: [], block: [] }));
    const dir = PATH.join(tmp, 'enforced');
    place(dir, 'unsigned-under-runtime', await plugin({ 'package.json': JSON.stringify({ name: 'unsigned-under-runtime' }), 'index.js': '' }, { signed: false }));
    assert.throws(() => use(dir), /unsigned, and a trusted signature is required \(carried over from the runtime\)/);
});
