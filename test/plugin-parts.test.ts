import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { use, list, runPlugin } from '../src/plugins.ts';
import { pinOf } from '../src/integrity.ts';
import { scopeDir } from '../src/scopes.ts';
import { ROOT, WINDOWS, build, scratch, tree } from './helpers.ts';

// Plugins a host pins by hash — its declared parts, or pins it passes —
// running a plugin as the main program, and workers started from inside a
// plugin. Module hooks and mounts last as long as this process, so every
// test uses a scope of its own.

const tmp = scratch('plugin-parts');
process.env['BUNDLE_PLUGINS'] = PATH.join(tmp, 'plugins');
process.env['BUNDLE_ATTESTATIONS'] = PATH.join(tmp, 'attestations');
process.env['BUNDLE_SYSTEM_POLICY'] = PATH.join(tmp, 'no-system-policy.json');
process.env['BUNDLE_POLICY'] = PATH.join(tmp, 'policy.json');
for (const name of ['BUNDLE_ATTESTERS', 'BUNDLE_BLOCK', 'BUNDLE_ROOTS', 'BUNDLE_IDENTITY', 'BUNDLE_ISSUER', 'BUNDLE_ROOT']) delete process.env[name];
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

const LOADER = pathToFileURL(PATH.join(ROOT, 'src', 'plugins.ts')).href;
let made = 0;

/** An unsigned plugin archive with these files. */
async function plugin(files: Record<string, string>): Promise<string> {
    const n = ++made;
    const source = tree(tmp, files, `source-${n}`);
    return await build(source, PATH.join(tmp, `plugin-${n}.nzip`), { signed: false, files: Object.keys(files) });
}

/** Put `archive` into a scope's directory, as `bundle install` lays it out. */
function place(scope: string, name: string, archive: string): string {
    const target = PATH.join(PATH.isAbsolute(scope) ? scope : scopeDir(scope), ...`${name}.nzip`.split('/'));
    FS.mkdirSync(PATH.dirname(target), { recursive: true });
    FS.copyFileSync(archive, target);
    return target;
}

/** A host on disk: its own package.json, its own dependency, and a module of the given body. */
function host(manifest: Record<string, unknown>, body: string): string {
    const dir = tree(tmp, {
        'package.json': JSON.stringify({ type: 'module', ...manifest }),
        'node_modules/host-api/package.json': JSON.stringify({ name: 'host-api', type: 'module', exports: './index.js' }),
        'node_modules/host-api/index.js': `export const api = { instance: Symbol('the host api') };`,
        'main.js': body,
    }, `host-${++made}`);
    return pathToFileURL(PATH.join(dir, 'main.js')).href;
}

const dynamic = (specifier: string): Promise<Record<string, unknown>> => import(specifier);

const SERVICE = {
    'package.json': JSON.stringify({ name: '@acme/svc', type: 'module', main: 'server.js', bin: { 'svc-tool': 'tool.cjs' }, ordner: { section: 'mail' } }),
    'server.js': 'globalThis.ran = { argv: process.argv.slice(1), url: import.meta.url };',
    'tool.cjs': 'globalThis.tool = { argv: process.argv.slice(2), file: __filename };',
};

test('a plugin the host pins loads only as those bytes — no signature needed — and anything else is refused', async () => {
    const dir = PATH.join(tmp, 'pinned');
    const good = await plugin({ 'package.json': JSON.stringify({ name: 'pinned-one', main: 'i.js' }), 'i.js': "module.exports = 'pinned';" });
    const other = await plugin({ 'package.json': JSON.stringify({ name: 'pinned-one', main: 'i.js' }), 'i.js': "module.exports = 'not the pinned bytes';" });
    place(dir, 'pinned-one', other);
    let error: Error & { code?: string; refused?: { package: string; reasons: string[] }[] } | undefined;
    try {
        use(dir, { verify: { pins: { 'pinned-one': pinOf(good)!, 'never-installed': pinOf(good)! } } });
    } catch (err) {
        error = err as typeof error;
    }
    assert.equal(error?.code, 'ERR_BUNDLE_UNTRUSTED');
    const reasons = Object.fromEntries(error!.refused!.map(({ package: pkg, reasons: why }) => [pkg, why.join('\n')]));
    assert.match(reasons['pinned-one']!, /its whole-file hash is sha256:\w+, and this app pins sha256:/);
    assert.match(reasons['never-installed']!, /pinned by this app, and not installed/);

    const fine = PATH.join(tmp, 'pinned-fine');
    place(fine, 'pinned-one', good);
    use(fine, { verify: { pins: { 'pinned-one': pinOf(good)! } } });
    assert.equal((await dynamic('pinned-one'))['default'], 'pinned', 'unsigned, and loaded: the pin is what vouches for it');
});

test('a host\'s own parts are pinned without asking: use() of its own scope reads its package.json', async () => {
    const good = await plugin({ 'package.json': JSON.stringify({ name: '@acme/part', type: 'module', exports: './i.js' }), 'i.js': "export default 'the part';" });
    const swapped = await plugin({ 'package.json': JSON.stringify({ name: '@acme/part', type: 'module', exports: './i.js' }), 'i.js': "export default 'swapped';" });
    const parts = { bundle: { parts: [{ package: '@acme/part', url: 'part.nzip', hash: pinOf(good)! }] } };

    place('@acme/host-a', '@acme/part', swapped);
    const refusing = host({ name: '@acme/host-a', ...parts }, `import { use } from ${JSON.stringify(LOADER)}; use('@acme/host-a');`);
    await assert.rejects(import(refusing), (err: Error & { code?: string }) => err.code === 'ERR_BUNDLE_UNTRUSTED'
        && /@acme\/host-a's parts \(.*package\.json\) pins sha256:/.test(err.message));

    place('@acme/host-b', '@acme/part', good);
    const loading = host({ name: '@acme/host-b', ...{ bundle: { parts: parts.bundle.parts } } }, `
        import { use } from ${JSON.stringify(LOADER)};
        use('@acme/host-b');
        export const part = (await import('@acme/part')).default;`);
    assert.equal((await import(loading) as { part: string }).part, 'the part');

    // A package that is not the scope declares nothing for it.
    place('@acme/host-c', '@acme/part', swapped);
    const stranger = host({ name: 'someone-else', ...parts }, `import { use } from ${JSON.stringify(LOADER)}; use('@acme/host-c');`);
    await import(stranger);
});

test('runPlugin runs a plugin as the main program: argv as --vfs-load makes it, and import.meta.url inside its mount', async () => {
    const archive = place('@acme/runner', '@acme/svc', await plugin(SERVICE));
    const global = globalThis as { ran?: { argv: string[]; url: string }; tool?: { argv: string[]; file: string } };
    const argv = process.argv;
    try {
        await runPlugin('@acme/runner', '@acme/svc', ['--port', '8080']);
        assert.deepEqual(global.ran!.argv, [archive, '--port', '8080'], 'argv[1] is the archive, then its own arguments');
        assert.match(global.ran!.url, /^file:\/\/.*\/server\.js$/);
        assert.equal(JSON.parse(FS.readFileSync(new URL('./package.json', global.ran!.url), 'utf-8')).name, '@acme/svc', 'its own files beside it');
        assert.equal(list('@acme/runner')[0]!.manifest['ordner'] !== undefined, true);

        await runPlugin('@acme/runner', '@acme/svc', ['check'], { bin: 'svc-tool' });
        assert.deepEqual(global.tool!.argv, ['check']);
        assert.match(global.tool!.file, /tool\.cjs$/);
        await assert.rejects(runPlugin('@acme/runner', '@acme/svc', [], { bin: 'nope' }), /has no bin 'nope'/);
        await assert.rejects(runPlugin('@acme/runner', '@acme/missing'), { code: 'ERR_MODULE_NOT_FOUND' });
    } finally {
        process.argv = argv;
    }
});

/** A plugin that starts a worker from its own archive, as a plugin would. */
const SCANNER = {
    'package.json': JSON.stringify({ name: '@acme/scanner', type: 'module', exports: './index.js' }),
    'index.js': `
        import { Worker } from 'node:worker_threads';
        export const url = import.meta.url;
        export function scan(input) {
            return new Promise((resolve, reject) => {
                const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: input });
                worker.once('message', (answer) => { worker.terminate(); resolve(answer); }).once('error', reject);
            });
        }`,
    'worker.js': `
        import { parentPort, workerData } from 'node:worker_threads';
        import { helper } from './lib/helper.js';
        import rules from '@acme/rules';
        import { api } from 'host-api';
        parentPort.postMessage({ url: import.meta.url, helper, rules, api: typeof api, data: workerData });`,
    'lib/helper.js': "export const helper = 'nested, from the worker';",
};
const RULES = { 'package.json': JSON.stringify({ name: '@acme/rules', type: 'module', exports: './i.js' }), 'i.js': "export default 'another plugin, from the worker';" };

test('a worker a plugin starts has its plugins, at the same URLs: nested imports, other plugins, the host\'s API', async () => {
    const dir = PATH.join(tmp, 'threads');
    place(dir, '@acme/scanner', await plugin(SCANNER));
    place(dir, '@acme/rules', await plugin(RULES));
    const main = host({ name: 'threads-host' }, `
        import { use } from ${JSON.stringify(LOADER)};
        use(${JSON.stringify(dir)});
        const scanner = await import('@acme/scanner');
        export const answer = { own: scanner.url, ...(await scanner.scan('mail')) };`);
    const { answer } = await import(main) as { answer: Record<string, unknown> };
    assert.equal(answer['url'], new URL('./worker.js', answer['own'] as string).href, 'the worker\'s script, where the plugin has it');
    const { own: _, url: __, ...rest } = answer;
    assert.deepEqual(rest, { helper: 'nested, from the worker', rules: 'another plugin, from the worker', api: 'object', data: 'mail' });
});

test('a pinned plugin is checked again in the worker: a file changed since is refused there', async () => {
    const dir = PATH.join(tmp, 'pinned-threads');
    const scanner = await plugin(SCANNER);
    const rules = await plugin(RULES);
    const placed = place(dir, '@acme/scanner', scanner);
    place(dir, '@acme/rules', rules);
    const pins = { '@acme/scanner': pinOf(scanner)!, '@acme/rules': pinOf(rules)! };
    const main = host({ name: 'pinned-threads-host' }, `
        import { use } from ${JSON.stringify(LOADER)};
        use(${JSON.stringify(dir)}, { verify: { pins: ${JSON.stringify(pins)} } });
        export const scanner = await import('@acme/scanner');`);
    const { scanner: loaded } = await import(main) as { scanner: { url: string; scan(input: string): Promise<Record<string, unknown>> } };
    const answer = await loaded.scan('pinned');
    assert.equal(answer['url'], loaded.url.replace(/index\.js$/, 'worker.js'), 'where the parent has it');
    assert.equal(answer['rules'], 'another plugin, from the worker');

    // Replaced on disk after the parent checked it: the parent keeps what it
    // checked, and a new worker checks the file as it is now. Windows will
    // not rename over a file a process has open, so there it cannot be.
    if (WINDOWS) return;
    const replacement = await plugin({ ...SCANNER, 'lib/helper.js': "export const helper = 'swapped';" });
    FS.copyFileSync(replacement, `${placed}.swap`);
    FS.renameSync(`${placed}.swap`, placed);
    await assert.rejects(loaded.scan('again'), (err: Error) => /its whole-file hash is sha256:\w+, and this app pins/.test(err.message));
});

test('a pinned plugin needs no verifier, and ./integrity no sigstore or attestations', async () => {
    // What a host that only pins loads is what its bundle carries: the
    // recording run puts it there. Neither may drag the verifier in.
    const dir = PATH.join(tmp, 'light');
    const name = 'light-one';
    const archive = place(dir, name, await plugin({ 'package.json': JSON.stringify({ name, main: 'i.js' }), 'i.js': '' }));
    const pin = pinOf(archive)!;
    const script = (body: string) => `
        import { registerHooks } from 'node:module';
        const seen = [];
        registerHooks({ resolve: (specifier, context, next) => { const found = next(specifier, context); seen.push(found.url); return found; } });
        ${body}
        const loaded = (part) => seen.some((url) => url.includes(part));
        console.log(JSON.stringify({ pinned: loaded('plugin-pinned'), provider: loaded('bundle-provider'), verifier: loaded('plugin-verifier'),
            sigstore: loaded('sigstore'), attestation: loaded('attestation'), manifest: loaded('/manifest.') }));`;
    const run = (body: string) => {
        const res = spawnSync(process.execPath, ['--no-warnings', '--experimental-vfs', '--input-type=module', '-e', script(body)], { encoding: 'utf-8' });
        assert.equal(res.status, 0, res.stderr);
        return JSON.parse(res.stdout) as Record<string, boolean>;
    };
    assert.deepEqual(run(`
        const { use } = await import(${JSON.stringify(LOADER)});
        use(${JSON.stringify(dir)}, { verify: { pins: { ${JSON.stringify(name)}: ${JSON.stringify(pin)} } } });`),
    { pinned: true, provider: true, verifier: false, sigstore: false, attestation: false, manifest: false }, 'mounted through BundleProvider, and nothing heavier');
    assert.deepEqual(run(`
        const { checkIntegrity } = await import(${JSON.stringify(pathToFileURL(PATH.join(ROOT, 'src', 'integrity.ts')).href)});
        if (!checkIntegrity(${JSON.stringify(archive)}).ok) throw new Error('not ok');`),
    { pinned: false, provider: false, verifier: false, sigstore: false, attestation: false, manifest: false });
});
