import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBundle } from '../src/api.ts';
import { ensureWindowsAssociation, parseRegQuery } from '../src/install.ts';
import { APP, WINDOWS, scratch, tree } from './helpers.ts';

// How an archive starts on Windows, which is the one thing a `#!` prefix cannot
// answer there.
//
// Unix runs a bundle because the first two bytes say `#!`. Windows runs it
// because of its *extension*: `.nzip` is associated with node, and `PATHEXT`
// makes the extension optional to type. That is the mechanism this package
// registers, and these are the tests for it — the mirror image of the launcher
// tests, which skip here for the same reason these skip there.
//
// **This test writes to the registry**, because there is no way to test a file
// association without one. It writes only under HKCU — no administrator needed
// — it snapshots what was there first, and puts it back in `after`, including
// the case where nothing was there and the keys have to go away again.

const SKIP = WINDOWS ? false : 'the .nzip association is a Windows mechanism; unix uses the #! prefix';

const tmp = scratch('windows');
const CLASSES = 'HKCU\\Software\\Classes';
const ENVIRONMENT = 'HKCU\\Environment';

/** One registry value, or null when it is not set. */
function read(key: string, name: string): string | null {
    const res = spawnSync('reg', ['query', key, ...(name ? ['/v', name] : ['/ve'])], { encoding: 'utf-8' });
    return res.status === 0 ? parseRegQuery(res.stdout ?? '', name) : null;
}

function reg(args: string[]): void {
    spawnSync('reg', args, { encoding: 'utf-8' });
}

// Everything this suite is about to change, so `after` can put it back.
const before = WINDOWS
    ? {
        extension: read(`${CLASSES}\\.nzip`, ''),
        command: read(`${CLASSES}\\NodeBundle\\shell\\open\\command`, ''),
        pathext: read(ENVIRONMENT, 'PATHEXT'),
    }
    : { extension: null, command: null, pathext: null };

test.after(() => {
    if (WINDOWS) {
        if (before.extension === null) reg(['delete', `${CLASSES}\\.nzip`, '/f']);
        else reg(['add', `${CLASSES}\\.nzip`, '/ve', '/d', before.extension, '/f']);
        if (before.command === null) reg(['delete', `${CLASSES}\\NodeBundle`, '/f']);
        else reg(['add', `${CLASSES}\\NodeBundle\\shell\\open\\command`, '/ve', '/d', before.command, '/f']);
        if (before.pathext === null) reg(['delete', ENVIRONMENT, '/v', 'PATHEXT', '/f']);
        else reg(['add', ENVIRONMENT, '/v', 'PATHEXT', '/t', 'REG_EXPAND_SZ', '/d', before.pathext, '/f']);
    }
    FS.rmSync(tmp, { recursive: true, force: true });
});

// An archive with nothing in front of it: the association is what starts it, so
// there is no prefix for the file to carry. Unsigned, because what is under
// test is how Windows *starts* a file.
const source = tree(tmp, { ...APP, 'index.js': "console.log('ran as', require('node:path').basename(process.argv[1]));" });
const ARCHIVE = PATH.join(tmp, 'app.nzip');
if (WINDOWS) await createBundle({ base: source, files: Object.keys(APP), output: ARCHIVE });

/**
 * Run `command` through cmd.exe, with this suite's directory on PATH and
 * `.NZIP` on PATHEXT — what a terminal opened after an install would have.
 */
function run(command: string): { status: number | null; stdout: string; stderr: string } {
    const res = spawnSync('cmd', ['/d', '/s', '/c', command], {
        encoding: 'utf-8',
        cwd: tmp,
        env: {
            ...process.env,
            PATH: `${tmp}${PATH.delimiter}${process.env['PATH'] ?? ''}`,
            PATHEXT: `${process.env['PATHEXT'] ?? ''};.NZIP`,
        },
    });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

test('the Windows setup registers .nzip and extends PATHEXT', { skip: SKIP }, () => {
    ensureWindowsAssociation('the tests');

    // What is asserted is the state, not what the call said about it: another
    // test file may have got there first, and either way the question is
    // whether the registry now holds what it should.
    assert.equal(read(`${CLASSES}\\.nzip`, ''), 'NodeBundle');
    const command = read(`${CLASSES}\\NodeBundle\\shell\\open\\command`, '');
    assert.match(command ?? '', /--experimental-vfs/, `stored: ${command}`);
    assert.match(command ?? '', /--vfs-load=/, `stored: ${command}`);
    // The extension is put back when the shell hands over a name without one,
    // which is what PATHEXT resolution does.
    assert.match(command ?? '', /%1\.nzip/, `stored: ${command}`);

    const pathext = read(ENVIRONMENT, 'PATHEXT');
    assert.ok(pathext?.split(';').some((ext) => ext.trim().toUpperCase() === '.NZIP'), pathext ?? '(unset)');
});

test('running the setup again changes nothing', { skip: SKIP }, () => {
    ensureWindowsAssociation('the tests');
    assert.deepEqual(ensureWindowsAssociation('the tests'), [], 'nothing left to do');
});

test('the association starts an archive, arguments and all', { skip: SKIP }, () => {
    ensureWindowsAssociation('the tests');
    const res = run(`"${ARCHIVE}" one two`);
    assert.equal(res.status, 0, `${res.stderr}\nopen command: ${read(`${CLASSES}\\NodeBundle\\shell\\open\\command`, '')}`);
    assert.match(res.stdout, /ran as app\.nzip/);
});

test('typed without the extension, found through PATHEXT', { skip: SKIP }, () => {
    // The case that is easy to get wrong: when cmd resolves `app` to `app.nzip`
    // through PATHEXT, it substitutes the name *as typed* — no extension — so a
    // command that simply mounted `%1` would be handed a path that is not a
    // file. This is what proves the open command copes.
    ensureWindowsAssociation('the tests');
    const res = run('app one two');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /ran as app\.nzip/);
});

test('a copy, a hard link and a symbolic link each report their own name', { skip: SKIP }, () => {
    ensureWindowsAssociation('the tests');

    FS.copyFileSync(ARCHIVE, PATH.join(tmp, 'copied.nzip'));
    assert.match(run('copied x').stdout, /ran as copied\.nzip/);

    // A hard link needs no rights; a symbolic link needs Developer Mode or
    // elevation, so it is reported rather than demanded.
    const linked = spawnSync('cmd', ['/d', '/s', '/c', `mklink /h "${PATH.join(tmp, 'hardlink.nzip')}" "${ARCHIVE}"`], { encoding: 'utf-8' });
    if (linked.status === 0) assert.match(run('hardlink x').stdout, /ran as hardlink\.nzip/);
    else assert.ok(true, `hard link unavailable: ${(linked.stderr || '').trim()}`);

    const symlinked = spawnSync('cmd', ['/d', '/s', '/c', `mklink "${PATH.join(tmp, 'symlink.nzip')}" "${ARCHIVE}"`], { encoding: 'utf-8' });
    if (symlinked.status === 0) assert.match(run('symlink x').stdout, /ran as symlink\.nzip/);
    else assert.ok(true, 'symbolic links need Developer Mode or elevation');
});

test('an archive behind a .ps1 does not run, as PowerShell parses first', { skip: SKIP }, () => {
    // Recorded as a test because it is the reason `.ps1` is not the mechanism:
    // PowerShell compiles the whole file before running any of it, so trailing
    // binary is a parse error rather than something `exit` can outrun. A pass
    // here would mean the .ps1 route deserves another look.
    const script = PATH.join(tmp, 'app.ps1');
    FS.copyFileSync(ARCHIVE, script);
    const res = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'x'], { encoding: 'utf-8' });
    assert.notEqual(res.status, 0, 'a .ps1 with an archive appended should not run');
});
