import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as CRYPTO from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createBundle, signBundle } from '../src/api.ts';
import { install, update, uninstall, records, recordPath, fileName, installDir } from '../src/install.ts';
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
// gets `examples/echo-argv/windows/probe.cmd`, and its parsing is unit-tested
// below. On Windows an archive is named `.nzip` so the association can find it,
// which is visible in the name every install ends up with.
const options = { roots, associate: false };
const installed = (name: string) => (WINDOWS ? `${name}.nzip` : name);

// The record and the install directory are per-process, so the environment is
// pointed at this suite's scratch space before anything touches them.
const HOME = PATH.join(tmp, 'home');
const BIN = PATH.join(HOME, 'bin');
process.env['BUNDLE_INSTALL_DIR'] = BIN;
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
const URL_ = `http://127.0.0.1:${port}/tool.run`;

test.after(() => {
    server.close();
    FS.rmSync(tmp, { recursive: true, force: true });
});

/** A signed archive whose entry point prints `tag`, so versions are visible. */
async function archive(tag: string): Promise<Buffer> {
    const dir = tree(PATH.join(tmp, tag), { ...APP, 'index.js': `console.log(${JSON.stringify(tag)});` }, 'app');
    const unsigned = PATH.join(tmp, `${tag}.bundle`);
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

    assert.equal(record.name, installed('tool.run'));
    assert.equal(record.dir, BIN);
    assert.equal(record.url, URL_);
    assert.equal(record.etag, '"one"');
    assert.equal(record.sha256, CRYPTO.createHash('sha256').update(first).digest('hex'));
    assert.match(record.subject ?? '', /Bundle Test Signer/);

    const file = PATH.join(BIN, installed('tool.run'));
    assert.deepEqual(FS.readFileSync(file), first);
    if (!WINDOWS) assert.ok(FS.statSync(file).mode & 0o111, 'executable');
    assert.deepEqual(Object.keys(records()), [installed('tool.run')]);
    assert.ok(FS.existsSync(recordPath()));
});

test('an archive that does not verify is never written', async () => {
    const tampered = Buffer.from(first);
    const at = Math.floor(tampered.length / 2);
    tampered[at] = (tampered[at] ?? 0) ^ 0xff;
    served.bytes = tampered;
    served.etag = '"tampered"';

    await assert.rejects(() => install(URL_, { ...options, name: 'bad.run' }), { code: 'ERR_BUNDLE_UNTRUSTED' });
    assert.equal(FS.existsSync(PATH.join(BIN, 'bad.run')), false);
    assert.equal(FS.readdirSync(BIN).some((name) => name.includes('incoming')), false, 'no leftovers');
});

test('an unanchored chain is refused unless it is asked for', async () => {
    served.bytes = first;
    served.etag = '"one"';
    await assert.rejects(() => install(URL_, { ...options, roots: [], name: 'untrusted.run' }), { code: 'ERR_BUNDLE_UNTRUSTED' });
    const record = await install(URL_, { ...options, roots: [], allowUntrusted: true, name: 'untrusted.run' });
    assert.equal(record.name, 'untrusted.run');
    uninstall('untrusted.run');
});

test('update asks conditionally, and does nothing when the server says 304', async () => {
    served.bytes = first;
    served.etag = '"one"';
    const before = hits;
    const [result] = await update(installed('tool.run'), options);
    assert.equal(result!.state, 'unchanged');
    assert.equal(hits, before + 1, 'one request');
    assert.deepEqual(FS.readFileSync(PATH.join(BIN, installed('tool.run'))), first);
});

test('update replaces the file when the publisher publishes something new', async () => {
    served.bytes = second;
    served.etag = '"two"';

    const [result] = await update(installed('tool.run'), options);
    assert.equal(result!.state, 'updated');
    assert.equal(result!.previous, CRYPTO.createHash('sha256').update(first).digest('hex'));
    assert.deepEqual(FS.readFileSync(PATH.join(BIN, installed('tool.run'))), second);
    assert.equal(records()[installed('tool.run')]!.etag, '"two"');
});

test('a server with no ETag does not cause a pointless reinstall', async () => {
    served.etag = '';
    const [result] = await update(installed('tool.run'), options);
    assert.equal(result!.state, 'unchanged', 'identical bytes are not an update');
});

test('update refuses an archive signed by somebody else', async () => {
    // The record pins whoever signed the first install. Here the archive still
    // verifies — it is just not from the identity that was installed.
    const all = records();
    all[installed('tool.run')] = { ...all[installed('tool.run')]!, identity: 'someone@else.example', issuer: 'https://accounts.example' };
    FS.writeFileSync(recordPath(), `${JSON.stringify({ version: 1, installs: all }, null, 2)}\n`);

    served.bytes = first;
    served.etag = '"three"';
    await assert.rejects(() => update(installed('tool.run'), options), { code: 'ERR_BUNDLE_UNTRUSTED' });
    assert.deepEqual(FS.readFileSync(PATH.join(BIN, installed('tool.run'))), second, 'the installed copy is untouched');
});

test('update with no name checks everything, and uninstall forgets one', async () => {
    served.bytes = first;
    served.etag = '"one"';
    await install(URL_, { ...options, name: 'other.run' });

    const results = await update(undefined, { ...options, allowUntrusted: true });
    assert.equal(results.length, Object.keys(records()).length);

    const record = uninstall('other.run');
    assert.equal(record.name, 'other.run');
    assert.equal(FS.existsSync(PATH.join(BIN, 'other.run')), false);
    assert.equal(Object.hasOwn(records(), 'other.run'), false);
});

test('the installed name comes from the server, and cannot escape the directory', () => {
    const named = (header: string | undefined, url = 'https://example.com/path/tool.run') =>
        fileName(new Response(null, { headers: header ? { 'content-disposition': header } : {} }), url);

    assert.equal(named(undefined), installed('tool.run'));
    assert.equal(named('attachment; filename="pnpm.run"'), installed('pnpm.run'));
    assert.equal(named("attachment; filename*=UTF-8''pnpm%20cli.run"), installed('pnpm cli.run'));
    // A filename is a suggestion from somebody else's server: it names a file,
    // never a path, and never a switch.
    assert.equal(named('attachment; filename="../../etc/cron.d/x"'), installed('x'));
    assert.equal(named('attachment; filename="/etc/passwd"'), installed('passwd'));
    assert.equal(named('attachment; filename="-rf"'), installed('tool.run'), 'falls back to the URL');
    assert.throws(() => named('attachment; filename=".."', 'https://example.com/'), /cannot tell what to call/);
});

test('install with no url means this package, from its own release', async () => {
    // The CLI path, because the defaulting lives there: no positional url, so
    // the self target and the identity that comes with it are used. The URL is
    // pointed at this suite's server; the identity requirement is real, and the
    // test PKI does not meet it — which is exactly what should be refused.
    const { main } = await import('../src/cli.ts');
    const { self, SELF } = await import('../src/install.ts');

    assert.equal(SELF.url, 'https://github.com/pipobscure/bundles/releases/latest/download/bundle.run');
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
        assert.equal(await main(['install', '--root', ROOT_PEM, '--identity', '', '--issuer', '', '--name', 'self.run'], forced), 0);
        assert.deepEqual(FS.readFileSync(PATH.join(BIN, 'self.run')), first);
        uninstall('self.run');
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
