import test from 'node:test';
import assert from 'node:assert/strict';
import * as CRYPTO from 'node:crypto';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as ZLIB from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { buildFor, checksumOf, chooseRelease, ensureNode, findNode, managers, nodesDir, ownNodes, unixRoots, type Release } from '../src/nodes.ts';
import { SHELL_BASE, WINDOWS, scratch } from './helpers.ts';

// Getting a node to run bundles with: which release, from where, checked how,
// and the same choice of node the launcher makes.

const tmp = scratch('nodes');
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

const release = (version: string, lts: string | false = false, files = ['linux-x64', 'linux-arm64', 'osx-arm64-tar', 'osx-x64-tar', 'win-x64-zip', 'win-arm64-zip']): Release => ({ version, lts, files });

test('the release is the newest LTS at or above the minimum, else the newest release, and has a build here', () => {
    const index = [release('v28.1.0'), release('v27.4.0', 'Kip'), release('v27.3.0', 'Kip'), release('v26.12.0', 'Jod'), release('v26.11.0', 'Jod')];
    assert.equal(chooseRelease(index, '26.11.1', 'linux', 'x64')?.version, 'v27.4.0', 'LTS over the newer current');
    assert.equal(chooseRelease(index, '28.0.0', 'linux', 'x64')?.version, 'v28.1.0', 'no LTS new enough: the newest release');
    assert.equal(chooseRelease(index, '29.0.0', 'linux', 'x64'), undefined);
    assert.equal(chooseRelease([release('v27.4.0', 'Kip', ['linux-x64']), release('v27.3.0', 'Kip')], '26.11.1', 'darwin', 'arm64')?.version, 'v27.3.0', 'one with a build for this platform');
    assert.equal(chooseRelease(index, '26.11.1', 'linux', 'ia32'), undefined, 'a CPU nodejs.org has no build for');
});

test('each platform\'s build is the archive nodejs.org names it, and the binary inside it', () => {
    assert.deepEqual(buildFor('v27.1.0', 'linux', 'arm64'), { key: 'linux-arm64', archive: 'node-v27.1.0-linux-arm64.tar.gz', member: 'node-v27.1.0-linux-arm64/bin/node' });
    assert.deepEqual(buildFor('v27.1.0', 'darwin', 'x64'), { key: 'osx-x64-tar', archive: 'node-v27.1.0-darwin-x64.tar.gz', member: 'node-v27.1.0-darwin-x64/bin/node' });
    assert.deepEqual(buildFor('v27.1.0', 'win32', 'x64'), { key: 'win-x64-zip', archive: 'node-v27.1.0-win-x64.zip', member: 'node-v27.1.0-win-x64/node.exe' });
    assert.equal(buildFor('v27.1.0', 'freebsd', 'x64'), undefined);
});

test('a checksum is read for exactly the file named, in either of shasum\'s forms', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const sums = `${a}  node-v27.1.0-linux-x64.tar.gz.extra\n${b}  node-v27.1.0-linux-x64.tar.gz\n${a} *node-v27.1.0-win-x64.zip\n`;
    assert.equal(checksumOf(sums, 'node-v27.1.0-linux-x64.tar.gz'), b);
    assert.equal(checksumOf(sums, 'node-v27.1.0-win-x64.zip'), a);
    assert.equal(checksumOf(sums, 'node-v27.1.0-darwin-x64.tar.gz'), undefined);
});

test('bundle keeps its nodes in its data directory, or where BUNDLE_NODE_DIR says', () => {
    assert.equal(nodesDir({}, 'linux', '/home/u'), '/home/u/.local/share/bundle/node');
    assert.equal(nodesDir({ XDG_DATA_HOME: '/d' }, 'linux', '/home/u'), '/d/bundle/node');
    assert.equal(nodesDir({}, 'darwin', '/Users/u'), '/Users/u/Library/Application Support/bundle/node');
    assert.equal(nodesDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Local\\bundle\\node');
    assert.equal(nodesDir({ BUNDLE_NODE_DIR: PATH.join(tmp, 'mine') }, 'linux', '/home/u'), PATH.join(tmp, 'mine'));
});

test('every place findNode looks, the launcher looks too', () => {
    const launcher = FS.readFileSync(SHELL_BASE, 'utf-8');
    // Each root as the launcher writes it, with the variables it defaults from.
    const spelled = ['"${NVM_DIR:-$HOME/.nvm}/versions/node" bin/node', '"$d/node-versions" installation/bin/node',
        '"${VOLTA_HOME:-$HOME/.volta}/tools/image/node" bin/node', '"${ASDF_DATA_DIR:-$HOME/.asdf}/installs/nodejs" bin/node',
        '"${MISE_DATA_DIR:-$data/mise}/installs/node" bin/node', '"${N_PREFIX:-/usr/local}/n/versions/node" bin/node',
        '"${BUNDLE_NODE_DIR:-$data/bundle/node}" bin/node', '"$HOME/Library/Application Support/bundle/node" bin/node'];
    for (const each of spelled) assert.ok(launcher.includes(`look ${each}`), each);
    assert.equal(unixRoots({}, '/h').length, spelled.length + 2, 'fnm is three roots, in one loop of the launcher');
});

/** A stand-in node: a file whose content is its version, as `run` reads it. */
function fakeNode(path: string, version: string): void {
    FS.mkdirSync(PATH.dirname(path), { recursive: true });
    FS.writeFileSync(path, version, { mode: 0o755 });
}
const run = (node: string) => {
    try {
        return FS.readFileSync(node, 'utf-8');
    } catch {
        return undefined;
    }
};

test('findNode picks as the launcher does: PATH when new enough, else the newest kept anywhere, bundle\'s own included', { skip: WINDOWS && 'the macOS and Linux search, with a PATH split on colons; Windows is windowsNode, tested in runtime.test.ts' }, () => {
    const home = PATH.join(tmp, 'h-find');
    const bin = PATH.join(tmp, 'p-find');
    fakeNode(PATH.join(bin, 'node'), 'v26.11.1');
    fakeNode(PATH.join(home, '.nvm', 'versions', 'node', 'v27.1.0', 'bin', 'node'), 'v27.1.0');
    fakeNode(PATH.join(home, '.local', 'share', 'bundle', 'node', 'v27.3.0', 'bin', 'node'), 'v27.3.0');
    const env = { PATH: bin };
    assert.deepEqual(findNode({ minimum: '26.11.1', env, home, platform: 'linux', run }), { path: PATH.join(bin, 'node'), version: 'v26.11.1', from: 'PATH' });
    assert.deepEqual(findNode({ minimum: '27.0.0', env, home, platform: 'linux', run }), {
        path: PATH.join(home, '.local', 'share', 'bundle', 'node', 'v27.3.0', 'bin', 'node'), version: 'v27.3.0', from: 'bundle',
    });
    fakeNode(PATH.join(home, 'Library', 'Application Support', 'bundle', 'node', 'v27.5.0', 'bin', 'node'), 'v27.5.0');
    assert.equal(findNode({ minimum: '27.0.0', env, home, platform: 'darwin', run })?.version, 'v27.5.0', 'and on macOS, its Application Support');
    assert.equal(findNode({ minimum: '28.0.0', env, home, platform: 'linux', run }), undefined);
});

test('a version manager is asked only when it would leave the default node alone', () => {
    const home = PATH.join(tmp, 'h-managers');
    const has = (...commands: string[]) => (command: string) => commands.includes(command);
    const names = (found: ReturnType<typeof managers>) => found.map((manager) => manager.name);
    assert.deepEqual(names(managers({ env: {}, home, platform: 'linux', has: has('mise', 'fnm', 'volta', 'n', 'asdf'), asdfHasNode: () => true })), ['mise', 'fnm', 'asdf'], 'never volta or n');
    assert.deepEqual(names(managers({ env: {}, home, platform: 'linux', has: has('asdf'), asdfHasNode: () => false })), [], 'asdf without its nodejs plugin');
    FS.mkdirSync(PATH.join(home, '.nvm'), { recursive: true });
    FS.writeFileSync(PATH.join(home, '.nvm', 'nvm.sh'), '');
    const [nvm] = managers({ env: {}, home, platform: 'linux', has: has() });
    assert.equal(nvm?.name, 'nvm');
    assert.deepEqual(nvm!.command('v27.1.0'), ['sh', '-c', '. "$1" && nvm install "$2"', 'nvm', PATH.posix.join(home, '.nvm', 'nvm.sh'), 'v27.1.0'], 'arguments, never spliced into the script');
    assert.deepEqual(managers({ env: {}, home, platform: 'win32', has: has('nvm.exe', 'volta.exe', 'mise.exe') }).map((manager) => manager.command('v27.1.0')),
        [['mise.exe', 'install', 'node@27.1.0'], ['nvm.exe', 'install', '27.1.0']]);
});

// A mirror of nodejs.org with one release, serving `archive` as its build for this platform.
function mirror(version: string, archive: string, bytes: Buffer, { sum = CRYPTO.createHash('sha256').update(bytes).digest('hex') } = {}) {
    const fetched: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        fetched.push(url);
        if (url.endsWith('/index.json')) return Response.json([release(version)]);
        if (url.endsWith(`/${version}/SHASUMS256.txt`)) return new Response(`${sum}  ${archive}\n`);
        if (url.endsWith(`/${version}/${archive}`)) return new Response(bytes);
        return new Response('not here', { status: 404 });
    }) as typeof globalThis.fetch;
    return { fetch, fetched };
}

test('with nothing here and no manager, the official build is downloaded, checked, and only its node kept', { skip: WINDOWS ? 'the tarball is the macOS and Linux build' : false }, async () => {
    const home = PATH.join(tmp, 'h-download');
    const version = 'v27.2.0';
    const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
    const build = buildFor(version, platform, 'x64')!;
    const src = PATH.join(tmp, 'tarball');
    fakeNode(PATH.join(src, ...build.member.split('/')), version);
    FS.writeFileSync(PATH.join(src, build.member.split('/')[0]!, 'README.md'), 'not kept');
    const tarball = PATH.join(tmp, build.archive);
    assert.equal(spawnSync('tar', ['-czf', tarball, '-C', src, build.member.split('/')[0]!]).status, 0);
    const bytes = FS.readFileSync(tarball);
    const env = { PATH: '', BUNDLE_NODE_MIRROR: 'https://mirror.test/dist' };
    const options = { env, home, platform, arch: 'x64', run, managers: [] } as const;

    const lines: string[] = [];
    const ensured = await ensureNode({ ...options, fetch: mirror(version, build.archive, bytes).fetch, log: (line) => lines.push(line) });
    const dir = PATH.join(nodesDir(env, platform, home), version);
    assert.deepEqual(ensured, { how: 'download', node: { path: PATH.join(dir, 'bin', 'node'), version, from: 'bundle' } });
    assert.deepEqual(FS.readdirSync(dir), ['bin'], 'the node binary, and nothing else of the release');
    assert.ok(lines.some((line) => line.includes('https://mirror.test/dist/v27.2.0/node-v27.2.0-')));
    assert.deepEqual(ownNodes(env, platform, home).map((each) => each.version), [version]);

    const again = mirror(version, build.archive, bytes);
    assert.equal((await ensureNode({ ...options, fetch: again.fetch })).how, 'found');
    assert.deepEqual(again.fetched, [], 'already here: nothing fetched');
});

test('a download that does not match its checksum, or a node that is not the version, is refused and leaves nothing', { skip: WINDOWS ? 'the tarball is the macOS and Linux build' : false }, async () => {
    const home = PATH.join(tmp, 'h-refused');
    const version = 'v27.2.0';
    const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
    const build = buildFor(version, platform, 'x64')!;
    const src = PATH.join(tmp, 'tarball-wrong');
    fakeNode(PATH.join(src, ...build.member.split('/')), 'v27.1.9');
    const tarball = PATH.join(tmp, `wrong-${build.archive}`);
    assert.equal(spawnSync('tar', ['-czf', tarball, '-C', src, build.member.split('/')[0]!]).status, 0);
    const bytes = FS.readFileSync(tarball);
    const options = { env: { PATH: '' }, home, platform, arch: 'x64', run, managers: [] } as const;

    await assert.rejects(ensureNode({ ...options, fetch: mirror(version, build.archive, bytes, { sum: '0'.repeat(64) }).fetch }), /sha256 [0-9a-f]{64}, but SHASUMS256\.txt says 0{64} — not installed/);
    await assert.rejects(ensureNode({ ...options, fetch: mirror(version, build.archive, bytes).fetch }), /says it is v27\.1\.9, not v27\.2\.0 — not installed/);
    assert.deepEqual(FS.readdirSync(nodesDir(options.env, platform, home)), [], 'no version directory, and no partial one');
});

test('on Windows, the node.exe out of the zip, read through node:zlib', { skip: WINDOWS ? false : 'the zip is the Windows build' }, async () => {
    const home = PATH.join(tmp, 'h-windows');
    const version = 'v27.2.0';
    const build = buildFor(version, 'win32', 'x64')!;
    const chunks: Buffer[] = [];
    for await (const chunk of ZLIB.createZipArchive([
        ZLIB.ZipEntry.createSync(build.member, Buffer.from(version)),
        ZLIB.ZipEntry.createSync(`node-${version}-win-x64/npm.cmd`, Buffer.from('not kept')),
    ])) chunks.push(chunk as Buffer);
    const env = { PATH: '', LOCALAPPDATA: PATH.join(home, 'Local'), APPDATA: PATH.join(home, 'Roaming') };
    const ensured = await ensureNode({ env, home, platform: 'win32', arch: 'x64', run, managers: [], fetch: mirror(version, build.archive, Buffer.concat(chunks)).fetch });
    assert.equal(ensured.node.path, PATH.join(home, 'Local', 'bundle', 'node', version, 'node.exe'));
    assert.deepEqual(FS.readdirSync(PATH.dirname(ensured.node.path)), ['node.exe']);
});

test('a version manager here is asked for the chosen release first, and a download is the fallback', async () => {
    const home = PATH.join(tmp, 'h-via');
    const version = 'v27.2.0';
    const asked: string[][] = [];
    const mise = { name: 'mise', command: (v: string) => ['mise', 'install', `node@${v.replace(/^v/, '')}`] };
    const options = { env: { PATH: '' }, home, platform: 'linux', arch: 'x64', run, managers: [mise], fetch: mirror(version, 'x', Buffer.alloc(0)).fetch } as const;
    const ensured = await ensureNode({
        ...options,
        spawn: (command) => {
            asked.push(command);
            fakeNode(PATH.join(home, '.local', 'share', 'mise', 'installs', 'node', '27.2.0', 'bin', 'node'), version);
            return { status: 0 };
        },
    });
    assert.deepEqual(asked, [['mise', 'install', 'node@27.2.0']]);
    assert.equal(ensured.how, 'mise');
    assert.equal(ensured.node.from, 'mise');

    await assert.rejects(ensureNode({ ...options, home: PATH.join(tmp, 'h-via-none'), via: 'fnm' }), /no version manager 'fnm' here — there is mise/);
});
