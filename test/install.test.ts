import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as CRYPTO from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createBundle, signBundle } from '../src/api.ts';
import { install, update, uninstall, installed as installedChecks, records, recordPath, fileName, installDir } from '../src/install.ts';
import { STATES } from '../src/manifest.ts';
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

test('uninstall takes a name, a url, or nothing at all', async () => {
    const { selfName, self } = await import('../src/install.ts');

    // By name.
    await install(URL_, { ...options, name: 'by-name.nzip' });
    assert.equal(uninstall('by-name.nzip').name, 'by-name.nzip');
    assert.equal(FS.existsSync(PATH.join(BIN, 'by-name.nzip')), false);

    // By the URL it came from, which is what a person remembers when the name
    // was the server's idea.
    await install(URL_, { ...options, name: 'by-url.nzip' });
    assert.equal(uninstall(URL_).name, 'by-url.nzip');
    assert.equal(Object.hasOwn(records(), 'by-url.nzip'), false);

    // With nothing: this package's own install, found by the URL it came from
    // whatever it ended up called.
    await install(URL_, { ...options, name: 'renamed-self.nzip' });
    const all = records();
    all['renamed-self.nzip'] = { ...all['renamed-self.nzip']!, url: self().url };
    FS.writeFileSync(recordPath(), `${JSON.stringify({ version: 1, installs: all }, null, 2)}\n`);
    assert.equal(uninstall().name, 'renamed-self.nzip');

    // ...and the errors say what there is rather than only what there is not.
    assert.throws(() => uninstall('nothing-like-this'), /nothing installed as/);
    assert.throws(() => uninstall('https://example.invalid/x.nzip'), /nothing installed from/);
    assert.throws(() => uninstall(), new RegExp(`this package is not installed as '${selfName()}'`));
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

test('install with no url means this package, from its own release', async () => {
    // The CLI path, because the defaulting lives there: no positional url, so
    // the self target and the identity that comes with it are used. The URL is
    // pointed at this suite's server; the identity requirement is real, and the
    // test PKI does not meet it — which is exactly what should be refused.
    const { main } = await import('../src/cli.ts');
    const { self, SELF } = await import('../src/install.ts');

    assert.equal(SELF.url, 'https://github.com/pipobscure/bundles/releases/latest/download/bundle.nzip');
    assert.match(SELF.identity, /publish\.yml@refs\/heads\/main$/);

    process.env['BUNDLE_SELF_SOURCE'] = URL_;
    try {
        assert.equal(self().url, URL_, 'a mirror can be pointed at, the identity still applies');
        served.bytes = first;
        served.etag = '"self"';

        const io = collector();
        assert.equal(await main(['install'], io), STATES['valid-untrusted'].code);
        assert.match(io.stderr.join('\n'), /installing this package itself/);
        assert.match(io.stderr.join('\n'), /a sigstore identity was required/);

        // ...and with the identity requirement lifted, the same fetch installs.
        const forced = collector();
        assert.equal(await main(['install', '--root', ROOT_PEM, '--identity', '', '--issuer', '', '--name', 'self.nzip'], forced), 0);
        assert.deepEqual(FS.readFileSync(PATH.join(BIN, 'self.nzip')), first);
        uninstall('self.nzip');
    } finally {
        delete process.env['BUNDLE_SELF_SOURCE'];
    }
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
