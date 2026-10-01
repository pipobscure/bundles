import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as CRYPTO from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createBundle, signBundle } from '../src/api.ts';
import { install, update, uninstall, installed as installedChecks, records, recordPath, fileName, installDir, resolveAlias } from '../src/install.ts';
import { APP, ROOT_PEM, WINDOWS, collector, scratch, testSigner, tree } from './helpers.ts';

// Installing from a URL, and keeping it current.
//
// Everything here runs against a server in this process, serving real signed
// archives — the point being that the checks are the ones a user gets, not a
// mock of them.

const tmp = scratch('install');
const roots = [ROOT_PEM];

// Installing never touches the registry here: a test suite has no business
// rewriting the PATHEXT of the machine it runs on. What that code does instead
// is tested by `windows.test.ts`, and its parsing is unit-tested below.
//
// The name an archive installs under is not the name it was served as: Windows
// needs `.nzip`, because the association is by extension, and nothing else
// wants it, because it sits between a person and the command they type.
const options = { roots, associate: false };
const installed = (name: string) => (WINDOWS ? `${name}.nzip` : name);

// What the server's `tool.nzip` ends up called once installed.
const TOOL = installed('tool');

// The record and the install directory are per-process, so the environment is
// pointed at this suite's scratch space before anything touches them.
const HOME = PATH.join(tmp, 'home');
const BIN = PATH.join(HOME, 'bin');
process.env['BUNDLE_INSTALL_DIR'] = BIN;
// These tests install for real, including through the CLI; none of them may
// leave a file association behind on the machine running them.
process.env['BUNDLE_NO_WINDOWS_SETUP'] = '1';
process.env['XDG_STATE_HOME'] = PATH.join(HOME, 'state');
process.env['LOCALAPPDATA'] = PATH.join(HOME, 'AppData');

/** What the server is currently serving, and under what ETag. */
const served: { bytes: Buffer; etag: string; disposition?: string | undefined } = {
    bytes: Buffer.alloc(0),
    etag: '"one"',
};
let hits = 0;

const server: Server = createServer((req, res) => {
    hits += 1;
    if (req.headers['if-none-match'] === served.etag) {
        res.writeHead(304).end();
        return;
    }
    const headers: Record<string, string> = { 'content-type': 'application/zip', etag: served.etag };
    if (served.disposition) headers['content-disposition'] = served.disposition;
    res.writeHead(200, headers).end(served.bytes);
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const URL_ = `http://127.0.0.1:${port}/tool.nzip`;

test.after(() => {
    server.close();
    FS.rmSync(tmp, { recursive: true, force: true });
});

/** A signed archive whose entry point prints `tag`, so versions are visible. */
async function archive(tag: string): Promise<Buffer> {
    const dir = tree(PATH.join(tmp, tag), { ...APP, 'index.js': `console.log(${JSON.stringify(tag)});` }, 'app');
    const unsigned = PATH.join(tmp, `${tag}.nzip`);
    const signed = PATH.join(tmp, `${tag}.signed`);
    await createBundle({ base: dir, files: Object.keys(APP), output: unsigned });
    await signBundle({ source: unsigned, output: signed, signer: testSigner() });
    return FS.readFileSync(signed);
}

const first = await archive('first');
const second = await archive('second');

test('install verifies before it writes, and records where it came from', async () => {
    served.bytes = first;
    served.etag = '"one"';
    const record = await install(URL_, options);

    assert.equal(record.name, TOOL);
    assert.equal(record.dir, BIN);
    assert.equal(record.url, URL_);
    assert.equal(record.etag, '"one"');
    assert.equal(record.sha256, CRYPTO.createHash('sha256').update(first).digest('hex'));
    assert.match(record.subject ?? '', /Bundle Test Signer/);

    const file = PATH.join(BIN, TOOL);
    assert.deepEqual(FS.readFileSync(file), first);
    if (!WINDOWS) assert.ok(FS.statSync(file).mode & 0o111, 'executable');
    assert.deepEqual(Object.keys(records()), [TOOL]);
    assert.ok(FS.existsSync(recordPath()));
});

test('an archive that does not verify is never written', async () => {
    const tampered = Buffer.from(first);
    const at = Math.floor(tampered.length / 2);
    tampered[at] = (tampered[at] ?? 0) ^ 0xff;
    served.bytes = tampered;
    served.etag = '"tampered"';

    await assert.rejects(() => install(URL_, { ...options, name: 'bad.nzip' }), { code: 'ERR_BUNDLE_UNTRUSTED' });
    assert.equal(FS.existsSync(PATH.join(BIN, 'bad.nzip')), false);
    assert.equal(FS.readdirSync(BIN).some((name) => name.includes('incoming')), false, 'no leftovers');
});

test('an unanchored chain is refused unless it is asked for', async () => {
    served.bytes = first;
    served.etag = '"one"';
    await assert.rejects(() => install(URL_, { ...options, roots: [], name: 'untrusted.nzip' }), { code: 'ERR_BUNDLE_UNTRUSTED' });
    const record = await install(URL_, { ...options, roots: [], allowUntrusted: true, name: 'untrusted.nzip' });
    assert.equal(record.name, 'untrusted.nzip');
    uninstall('untrusted.nzip');
});

test('update asks conditionally, and does nothing when the server says 304', async () => {
    served.bytes = first;
    served.etag = '"one"';
    const before = hits;
    const [result] = await update(TOOL, options);
    assert.equal(result!.state, 'unchanged');
    assert.equal(hits, before + 1, 'one request');
    assert.deepEqual(FS.readFileSync(PATH.join(BIN, TOOL)), first);
});

test('update replaces the file when the publisher publishes something new', async () => {
    served.bytes = second;
    served.etag = '"two"';

    const [result] = await update(TOOL, options);
    assert.equal(result!.state, 'updated');
    assert.equal(result!.previous, CRYPTO.createHash('sha256').update(first).digest('hex'));
    assert.deepEqual(FS.readFileSync(PATH.join(BIN, TOOL)), second);
    assert.equal(records()[TOOL]!.etag, '"two"');
});

test('a server with no ETag does not cause a pointless reinstall', async () => {
    served.etag = '';
    const [result] = await update(TOOL, options);
    assert.equal(result!.state, 'unchanged', 'identical bytes are not an update');
});

test('update refuses an archive signed by somebody else', async () => {
    // The record pins whoever signed the first install. Here the archive still
    // verifies — it is just not from the identity that was installed.
    const all = records();
    all[TOOL] = { ...all[TOOL]!, identity: 'someone@else.example', issuer: 'https://accounts.example' };
    FS.writeFileSync(recordPath(), `${JSON.stringify({ version: 1, installs: all }, null, 2)}\n`);

    served.bytes = first;
    served.etag = '"three"';
    await assert.rejects(() => update(TOOL, options), { code: 'ERR_BUNDLE_UNTRUSTED' });
    assert.deepEqual(FS.readFileSync(PATH.join(BIN, TOOL)), second, 'the installed copy is untouched');
});

test('installed re-checks each record: the bytes, and who signed them', async () => {
    served.bytes = first;
    served.etag = '"checks"';
    await install(URL_, { ...options, name: 'checked.nzip' });
    const file = PATH.join(BIN, 'checked.nzip');

    const ok = installedChecks({ roots }).find((check) => check.record.name === 'checked.nzip');
    assert.equal(ok?.state, 'ok');
    assert.equal(ok?.path, file);
    assert.equal(ok?.sha256, CRYPTO.createHash('sha256').update(first).digest('hex'));

    // Something other than `update` replaced the file. The replacement here is
    // a perfectly good archive — signed, verifying — which is the point: only
    // the hash notices, because the record says which bytes were installed.
    FS.writeFileSync(file, second);
    const changed = installedChecks({ roots }).find((check) => check.record.name === 'checked.nzip');
    assert.equal(changed?.state, 'changed');
    assert.match(changed?.reason ?? '', /not the bytes that were installed/);

    // Tampered rather than replaced: the hash moves too, so this is `changed`
    // as well — the check that runs first is the cheaper one.
    const tampered = Buffer.from(first);
    const at = Math.floor(tampered.length / 2);
    tampered[at] = (tampered[at] ?? 0) ^ 0xff;
    FS.writeFileSync(file, tampered);
    assert.equal(installedChecks({ roots }).find((c) => c.record.name === 'checked.nzip')?.state, 'changed');

    // Gone.
    FS.rmSync(file);
    const missing = installedChecks({ roots }).find((check) => check.record.name === 'checked.nzip');
    assert.equal(missing?.state, 'missing');
    assert.match(missing?.reason ?? '', /not there any more/);

    // A record whose file is fine but whose signer is no longer accepted.
    FS.writeFileSync(file, first);
    assert.equal(installedChecks({ roots: [] }).find((c) => c.record.name === 'checked.nzip')?.state, 'valid-untrusted');

    uninstall('checked.nzip');
});

test('uninstall takes a name or a url', async () => {
    // By name.
    await install(URL_, { ...options, name: 'by-name.nzip' });
    assert.equal(uninstall('by-name.nzip').name, 'by-name.nzip');
    assert.equal(FS.existsSync(PATH.join(BIN, 'by-name.nzip')), false);

    // By the URL it came from, which is what a person remembers when the name
    // was the server's idea.
    await install(URL_, { ...options, name: 'by-url.nzip' });
    assert.equal(uninstall(URL_).name, 'by-url.nzip');
    assert.equal(Object.hasOwn(records(), 'by-url.nzip'), false);

    // ...and the errors say what there is rather than only what there is not.
    assert.throws(() => uninstall('nothing-like-this'), /nothing installed as/);
    assert.throws(() => uninstall('https://example.invalid/x.nzip'), /nothing installed from/);
});

test('update with no name checks everything, and uninstall forgets one', async () => {
    served.bytes = first;
    served.etag = '"one"';
    await install(URL_, { ...options, name: 'other.nzip' });

    const results = await update(undefined, { ...options, allowUntrusted: true });
    assert.equal(results.length, Object.keys(records()).length);

    const record = uninstall('other.nzip');
    assert.equal(record.name, 'other.nzip');
    assert.equal(FS.existsSync(PATH.join(BIN, 'other.nzip')), false);
    assert.equal(Object.hasOwn(records(), 'other.nzip'), false);
});

test('the installed name comes from the server, and cannot escape the directory', () => {
    const named = (header: string | undefined, url = 'https://example.com/path/tool.nzip') =>
        fileName(new Response(null, { headers: header ? { 'content-disposition': header } : {} }), url);

    assert.equal(named(undefined), TOOL);
    assert.equal(named('attachment; filename="pnpm.nzip"'), installed('pnpm'));
    assert.equal(named("attachment; filename*=UTF-8''pnpm%20cli.nzip"), installed('pnpm cli'));
    // An extension that is not ours is the publisher's business, and is kept.
    assert.equal(named('attachment; filename="pnpm.tar"'), installed('pnpm.tar'));

    // `.nzip` is the one extension this tool decides for itself: it goes on for
    // Windows, where it is the mechanism, and comes off everywhere else, so
    // `bundle.nzip` is the command `bundle`.
    assert.equal(named('attachment; filename="bundle.nzip"'), WINDOWS ? 'bundle.nzip' : 'bundle');
    assert.equal(named(undefined, 'https://example.com/d/pnpm.nzip'), WINDOWS ? 'pnpm.nzip' : 'pnpm');
    assert.equal(named('attachment; filename=".nzip"'), WINDOWS ? '.nzip' : '.nzip', 'never left with no name');
    // A filename is a suggestion from somebody else's server: it names a file,
    // never a path, and never a switch.
    assert.equal(named('attachment; filename="../../etc/cron.d/x"'), installed('x'));
    assert.equal(named('attachment; filename="/etc/passwd"'), installed('passwd'));
    assert.equal(named('attachment; filename="-rf"'), TOOL, 'falls back to the URL');
    assert.throws(() => named('attachment; filename=".."', 'https://example.com/'), /cannot tell what to call/);
});

test('a domain\'s nzip: TXT record says what to fetch, and its first label what to call it', async () => {
    const txt = (...records: string[][]) => async () => records;
    const alias = (...records: string[][]) => resolveAlias('npm.npmjs.org', txt(...records));

    // Relative to the domain, absolute, and split into 255-byte chunks — which
    // is how DNS delivers a long record, and is still one value.
    assert.deepEqual(await alias(['v=spf1 -all'], ['nzip:/app/npm.nzip']),
        { domain: 'npm.npmjs.org', name: installed('npm'), url: 'https://npm.npmjs.org/app/npm.nzip' });
    assert.deepEqual(await alias(['nzip:https://cdn.example.com/npm.nzip']),
        { domain: 'npm.npmjs.org', name: installed('npm'), url: 'https://cdn.example.com/npm.nzip' });
    assert.equal((await alias(['nzip:https://cdn.exa', 'mple.com/npm.nzip'])).url, 'https://cdn.example.com/npm.nzip');
    assert.equal((await alias(['nzip:/a.nzip'], ['nzip:/a.nzip'])).url, 'https://npm.npmjs.org/a.nzip', 'a duplicate is one answer');
    assert.deepEqual(await resolveAlias('NPMJS.org.', txt(['nzip:x.nzip'])),
        { domain: 'npmjs.org', name: installed('npmjs'), url: 'https://npmjs.org/x.nzip' });

    await assert.rejects(() => alias(['v=spf1 -all']), /no 'nzip:<url>' TXT record/);
    await assert.rejects(() => alias(['nzip:/a.nzip'], ['nzip:/b.nzip']), /2 different 'nzip:' records/);
    await assert.rejects(() => alias(['nzip:']), /not of the form/);
    // Plain HTTP would let anyone on the path choose the bytes.
    await assert.rejects(() => alias(['nzip:http://npmjs.org/npm.nzip']), /not https/);
    await assert.rejects(() => resolveAlias('nowhere.example', async () => {
        throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
    }), /has no TXT records/);
});

test('install takes a domain, and uninstall finds it again by that domain', async () => {
    served.bytes = first;
    served.etag = '"aliased"';
    served.disposition = 'attachment; filename="ignored.nzip"';

    // Aliases are https only; this suite's server is not, so that one origin is
    // pointed at it. Everything after the fetch is the real thing.
    const original = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        return original(url.replace('https://mytool.example/', `http://127.0.0.1:${port}/`), init);
    }) as typeof fetch;
    try {
        const looked: string[] = [];
        const record = await install('mytool.example', {
            ...options,
            resolveTxt: async (domain) => (looked.push(domain), [['nzip:/dl/tool.nzip']]),
        });
        assert.deepEqual(looked, ['mytool.example']);
        assert.equal(record.name, installed('mytool'), 'the domain names it, not the server');
        assert.equal(record.url, 'https://mytool.example/dl/tool.nzip');
        assert.equal(record.alias, 'mytool.example');
        assert.deepEqual(FS.readFileSync(PATH.join(BIN, record.name)), first);

        assert.equal(uninstall('mytool.example').name, installed('mytool'));
        assert.equal(FS.existsSync(PATH.join(BIN, record.name)), false);
    } finally {
        globalThis.fetch = original;
        served.disposition = undefined;
    }

    await assert.rejects(() => install('not a domain', options), /neither a URL nor a domain/);
});

test('install and uninstall need to be told what', async () => {
    const { main } = await import('../src/cli.ts');
    const bare = collector();
    assert.equal(await main(['install'], bare), 70);
    assert.match(bare.stderr.join('\n'), /install: a url or a domain is required/);
    const nothing = collector();
    assert.equal(await main(['uninstall'], nothing), 70);
    assert.match(nothing.stderr.join('\n'), /uninstall: a name, a url or a domain is required/);
});

test('reg query output is read by name, values with spaces included', async () => {
    const { parseRegQuery, ensureWindowsAssociation } = await import('../src/install.ts');

    // What `reg query HKCU\\Software\\Classes\\NodeBundle\\shell\\open\\command /ve` prints.
    const command = [
        '',
        'HKEY_CURRENT_USER\\Software\\Classes\\NodeBundle\\shell\\open\\command',
        '    (Default)    REG_SZ    "C:\\Program Files\\nodejs\\node.exe" --experimental-vfs --vfs-load="%1" -- %~2',
        '',
    ].join('\r\n');
    assert.equal(parseRegQuery(command, ''),
        '"C:\\Program Files\\nodejs\\node.exe" --experimental-vfs --vfs-load="%1" -- %~2');
    assert.equal(parseRegQuery(command, 'PATHEXT'), null, 'a value that is not there is not there');

    // A named REG_EXPAND_SZ, as HKCU\Environment holds PATHEXT.
    const environment = [
        '',
        'HKEY_CURRENT_USER\\Environment',
        '    PATH    REG_EXPAND_SZ    %USERPROFILE%\\bin',
        '    PATHEXT    REG_EXPAND_SZ    %PATHEXT%;.NZIP',
        '',
    ].join('\r\n');
    assert.equal(parseRegQuery(environment, 'PATHEXT'), '%PATHEXT%;.NZIP');
    assert.equal(parseRegQuery(environment, 'PATH'), '%USERPROFILE%\\bin', 'the prefix of another name does not match');
    assert.equal(parseRegQuery('ERROR: The system was unable to find the specified registry key', 'PATHEXT'), null);

    // Everywhere else this is not a thing, and asking is not an error.
    if (process.platform !== 'win32') assert.deepEqual(ensureWindowsAssociation(), []);
});

test('the install directory is this tool\'s own, and says so when it is not on PATH', () => {
    assert.equal(installDir(), BIN);
    delete process.env['BUNDLE_INSTALL_DIR'];
    const fallback = installDir();
    process.env['BUNDLE_INSTALL_DIR'] = BIN;
    assert.match(fallback, process.platform === 'win32' ? /bundle[\\/]bin$/ : /\.local[\\/]bin$/);
});
