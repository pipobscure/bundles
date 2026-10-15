import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { spawnSync } from 'node:child_process';
import { FLOOR, atLeast, minimumNode, launcherText, windowsNode } from '../src/runtime.ts';
import { main } from '../src/cli.ts';
import { prefixLength } from '../src/archive.ts';
import { APP, SHELL_BASE, WINDOWS, collector, scratch, tree } from './helpers.ts';

// Which node runs a bundle: the minimum a launcher is written with, the
// launcher finding a node new enough — on PATH first, then from a version
// manager — and the node a Windows association names.

const tmp = scratch('runtime');
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

test('the minimum is engines.node\'s lower bound, never below the floor, and an upper bound is said', () => {
    const cases: [string | undefined, string, boolean][] = [
        [undefined, FLOOR, false],
        ['*', FLOOR, false],
        ['>=22', FLOOR, false],
        ['>=27.1.0', '27.1.0', false],
        ['>= 27', '27.0.0', false],
        ['>27.1.0', '27.1.1', false],
        ['>27', '28.0.0', false],
        ['^27.1.0', '27.1.0', true],
        ['~27.1', '27.1.0', true],
        ['27.x || 28', '27.0.0', true],
        ['28 || >=27.2', '27.2.0', true],
        ['27.1 - 28', '27.1.0', true],
        ['>=27 <29', '27.0.0', true],
        ['27.1.0', '27.1.0', true],
        ['>=27.0.0-rc.1', '27.0.0-rc.1', false],
    ];
    for (const [range, minimum, upper] of cases) assert.deepEqual(minimumNode(range), { minimum, upper }, String(range));
    assert.throws(() => minimumNode('latest'), /engines\.node 'latest': cannot read 'latest'/);
});

test('versions compare as the launcher compares them: parts in order, a pre-release before its release', () => {
    assert.ok(atLeast('v27.0.0', '26.11.1'));
    assert.ok(atLeast('26.11.1', '26.11.1'));
    assert.ok(!atLeast('v26.9.9', '26.11.1'), 'numerically, not as text');
    assert.ok(atLeast('v27.0.0-pre', '26.11.1'));
    assert.ok(!atLeast('v27.0.0-pre', '27.0.0'), 'a pre-release comes before its release');
    assert.ok(atLeast('27', '26.11.1'), 'a missing part is 0');
    assert.ok(!atLeast('lts-iron', '1.0.0'), 'not a version, never enough');
});

test('the launcher is written with the minimum it checks for, and is otherwise the one shipped', () => {
    const shipped = FS.readFileSync(SHELL_BASE, 'utf-8');
    assert.match(shipped, new RegExp(`^need=${FLOOR.replace(/\./g, '\\.')}$`, 'm'), 'shipped with the floor');
    assert.equal(launcherText(), shipped);
    const written = launcherText('27.1.0');
    assert.match(written, /^need=27\.1\.0$/m);
    assert.equal(written.replace(/^need=.*$/m, ''), shipped.replace(/^need=.*$/m, ''));
    assert.throws(() => launcherText('27; rm -rf /'), /not a node version/);
});

// ------------------------------------------------------- the launcher, run ---

const SKIP = WINDOWS ? 'the #! launcher is a unix mechanism; Windows opens .nzip through its association' : false;

/** A stand-in node: says its version, or says that it ran and with what. */
function fakeNode(path: string, version: string): void {
    FS.mkdirSync(PATH.dirname(path), { recursive: true });
    FS.writeFileSync(path, `#!/bin/sh\n[ "$1" = --version ] && { echo ${version}; exit 0; }\necho "ran ${version} $*"\n`, { mode: 0o755 });
}

// The launcher, with `need` set, run by `sh` with only `path` on PATH (and the
// system's own directories, for the tools it uses) and `home` as HOME.
function launch(need: string, { path = [], home, env = {} }: { path?: string[]; home: string; env?: Record<string, string> }) {
    const script = PATH.join(tmp, `launcher-${need}`);
    FS.writeFileSync(script, launcherText(need), { mode: 0o755 });
    // A directory with every tool the launcher uses, and no node.
    const tools = PATH.join(tmp, 'tools');
    if (!FS.existsSync(tools)) {
        FS.mkdirSync(tools);
        for (const tool of ['sh', 'echo', '[', 'test']) {
            const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf-8' }).stdout.trim();
            if (found.startsWith('/')) FS.symlinkSync(found, PATH.join(tools, tool));
        }
    }
    return spawnSync('sh', [script, 'one', 'two words'], {
        encoding: 'utf-8',
        env: { PATH: [...path, tools].join(':'), HOME: home, ...env },
    });
}

test('the launcher runs the node on PATH when it is new enough — whatever a version manager has', { skip: SKIP }, () => {
    const home = PATH.join(tmp, 'h-prefer');
    fakeNode(PATH.join(tmp, 'p-prefer', 'node'), 'v27.0.0');
    fakeNode(PATH.join(home, '.nvm', 'versions', 'node', 'v28.0.0', 'bin', 'node'), 'v28.0.0');
    const res = launch('26.11.1', { path: [PATH.join(tmp, 'p-prefer')], home });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^ran v27\.0\.0 --no-warnings --experimental-vfs --vfs-load=\S+ -- one two words$/m);
});

test('a node on PATH too old for the app: the newest a version manager has, from any of them', { skip: SKIP }, () => {
    const home = PATH.join(tmp, 'h-managers');
    const old = PATH.join(tmp, 'p-old');
    fakeNode(PATH.join(old, 'node'), 'v26.11.1');
    fakeNode(PATH.join(home, '.nvm', 'versions', 'node', 'v27.1.0', 'bin', 'node'), 'v27.1.0');
    fakeNode(PATH.join(home, '.local', 'share', 'fnm', 'node-versions', 'v27.4.0', 'installation', 'bin', 'node'), 'v27.4.0');
    fakeNode(PATH.join(home, 'Library', 'Application Support', 'fnm', 'node-versions', 'v27.3.0', 'installation', 'bin', 'node'), 'v27.3.0');
    fakeNode(PATH.join(home, '.volta', 'tools', 'image', 'node', '27.2.0', 'bin', 'node'), 'v27.2.0');
    fakeNode(PATH.join(home, '.asdf', 'installs', 'nodejs', '27.0.5', 'bin', 'node'), 'v27.0.5');
    fakeNode(PATH.join(home, '.local', 'share', 'mise', 'installs', 'node', '27.3.5', 'bin', 'node'), 'v27.3.5');
    // A pre-release of a newer one is not the release the app asks for.
    fakeNode(PATH.join(home, '.nvm', 'versions', 'node', 'v27.5.0-rc.1', 'bin', 'node'), 'v27.5.0-rc.1');

    assert.match(launch('27.1.0', { path: [old], home }).stdout, /^ran v27\.5\.0-rc\.1 /m, 'the newest, a pre-release of a version past the minimum');
    FS.rmSync(PATH.join(home, '.nvm', 'versions', 'node', 'v27.5.0-rc.1'), { recursive: true });
    assert.match(launch('27.1.0', { path: [old], home }).stdout, /^ran v27\.4\.0 /m, 'fnm, in the XDG data directory');
    // Where each manager is told to keep them, it is looked for there.
    const elsewhere = PATH.join(tmp, 'n-prefix');
    fakeNode(PATH.join(elsewhere, 'n', 'versions', 'node', '27.9.0', 'bin', 'node'), 'v27.9.0');
    assert.match(launch('27.1.0', { path: [old], home, env: { N_PREFIX: elsewhere } }).stdout, /^ran v27\.9\.0 /m, 'n, under N_PREFIX');
    // No node on PATH at all is the same question.
    assert.match(launch('27.1.0', { home }).stdout, /^ran v27\.4\.0 /m);
});

test('with no node new enough anywhere, the launcher says what it found and how to fix it', { skip: SKIP }, () => {
    const home = PATH.join(tmp, 'h-none');
    fakeNode(PATH.join(tmp, 'p-none', 'node'), 'v26.11.1');
    fakeNode(PATH.join(home, '.nvm', 'versions', 'node', 'v27.0.0', 'bin', 'node'), 'v27.0.0');
    const res = launch('28.0.0', { path: [PATH.join(tmp, 'p-none')], home });
    assert.equal(res.status, 69);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /^launcher-28\.0\.0: needs node 28\.0\.0 or newer, and none was found$/m);
    assert.match(res.stderr, /^ {2}on PATH: node v26\.11\.1 at \S+p-none\/node$/m);
    assert.match(res.stderr, /version managers \(nvm, fnm, volta, asdf, mise, n\): none has one installed/);
    assert.match(res.stderr, /install node 28 or newer — e\.g\. 'nvm install 28' or 'fnm install 28', or from https:\/\/nodejs\.org/);

    const bare = launch('28.0.0', { home: PATH.join(tmp, 'h-empty') });
    assert.equal(bare.status, 69);
    assert.match(bare.stderr, /^ {2}on PATH: no node$/m);

    // A directory that says it is new enough, holding a node that is not, does not count.
    fakeNode(PATH.join(home, '.nvm', 'versions', 'node', 'v28.1.0', 'bin', 'node'), 'v27.0.0');
    assert.equal(launch('28.0.0', { path: [PATH.join(tmp, 'p-none')], home }).status, 69);
});

// ---------------------------------------------------------------- create ---

test('create --launcher asks for the node the app\'s engines.node does, and says so', async () => {
    const files = PATH.join(tmp, 'engines.files');
    FS.writeFileSync(files, Object.keys(APP).join('\n'));
    const make = async (engines: string | undefined, name: string) => {
        const pkg = { name: 'demo', type: 'module', main: 'index.js', ...(engines !== undefined ? { engines: { node: engines } } : {}) };
        const base = tree(tmp, { ...APP, 'package.json': JSON.stringify(pkg) }, name);
        const output = PATH.join(tmp, `${name}.run`);
        const io = collector();
        const code = await main(['create', '--base', base, '--files', files, '--launcher', '--output', output], io);
        const prefix = code === 0 ? FS.readFileSync(output).subarray(0, prefixLength(output)).toString('utf-8') : '';
        return { code, prefix, err: io.stderr.join('\n') };
    };

    const plain = await make(undefined, 'eng-none');
    assert.match(plain.prefix, new RegExp(`^need=${FLOOR.replace(/\./g, '\\.')}$`, 'm'));
    assert.match(plain.err, new RegExp(`\\* launcher: runs with node ${FLOOR.replace(/\./g, '\\.')} or newer$`, 'm'));

    const newer = await make('>=27.1.0', 'eng-newer');
    assert.match(newer.prefix, /^need=27\.1\.0$/m);
    assert.match(newer.err, /\* launcher: runs with node 27\.1\.0 or newer \(engines\.node '>=27\.1\.0'\)/);
    assert.doesNotMatch(newer.err, /upper bound/);

    const capped = await make('^27.2', 'eng-capped');
    assert.match(capped.prefix, /^need=27\.2\.0$/m);
    assert.match(capped.err, /! engines\.node '\^27\.2' also has an upper bound, which the launcher does not check: it runs with any node from 27\.2\.0 on/);

    const older = await make('>=20', 'eng-older');
    assert.match(older.prefix, new RegExp(`^need=${FLOOR.replace(/\./g, '\\.')}$`, 'm'), 'never below what --vfs-load needs');

    const unreadable = await make('lts', 'eng-unreadable');
    assert.equal(unreadable.code, 70);
    assert.match(unreadable.err, /engines\.node 'lts': cannot read 'lts'/);
    assert.equal(FS.existsSync(PATH.join(tmp, 'eng-unreadable.run')), false);
});

// ---------------------------------------------------------------- Windows ---

test('on Windows, .nzip opens with the node on PATH, else this one, else the newest a version manager has', () => {
    const root = PATH.join(tmp, 'win');
    const exe = (path: string) => { FS.mkdirSync(PATH.dirname(path), { recursive: true }); FS.writeFileSync(path, ''); return path; };
    // What each node says it is, as `--version` would.
    const versions = new Map<string, string>();
    const node = (path: string, version: string) => { versions.set(exe(path), version); return path; };
    const run = (path: string) => versions.get(path);
    const env = { PATH: PATH.join(root, 'bin'), APPDATA: PATH.join(root, 'Roaming'), LOCALAPPDATA: PATH.join(root, 'Local') };
    const execPath = node(PATH.join(root, 'running', 'node.exe'), 'v26.11.1');

    const onPath = node(PATH.join(root, 'bin', 'node.exe'), 'v27.0.0');
    node(PATH.join(root, 'Roaming', 'nvm', 'v28.0.0', 'node.exe'), 'v28.0.0');
    assert.deepEqual(windowsNode({ env, execPath, run }), { path: onPath, version: 'v27.0.0', from: 'PATH' }, 'PATH first');

    versions.set(onPath, 'v22.0.0');
    assert.equal(windowsNode({ env, execPath, run })?.from, 'this process', 'then the node running this');

    versions.set(execPath, 'v24.0.0');
    node(PATH.join(root, 'Roaming', 'fnm', 'node-versions', 'v28.2.0', 'installation', 'node.exe'), 'v28.2.0');
    node(PATH.join(root, 'Local', 'Volta', 'tools', 'image', 'node', '28.1.0', 'node.exe'), 'v28.1.0');
    node(PATH.join(root, 'Local', 'mise', 'installs', 'node', '27.9.0', 'node.exe'), 'v27.9.0');
    assert.deepEqual(windowsNode({ env, execPath, run }), {
        path: PATH.join(root, 'Roaming', 'fnm', 'node-versions', 'v28.2.0', 'installation', 'node.exe'), version: 'v28.2.0', from: 'fnm',
    }, 'then the newest a version manager has');
    assert.equal(windowsNode({ env: { ...env, NVM_HOME: PATH.join(root, 'nvm-home') }, execPath, run, minimum: '28.2.0' })?.from, 'fnm');
    assert.equal(windowsNode({ env, execPath, run, minimum: '29.0.0' }), undefined, 'none new enough');
});
