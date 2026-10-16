import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { ico, icns, pngSize, ICO_SIZES, ICNS_TYPES } from '../tools/icons.ts';
import {
    ensureFreedesktopFileType, ensureMacFileType, macAppDir, macInfoPlist, mimePackageXml, desktopSetupWanted,
    NZIP_MIME, NZIP_UTI, type Runner,
} from '../src/install.ts';
import { iconPath } from '../src/files.ts';
import { ROOT, scratch } from './helpers.ts';

// The icon `.nzip` files get, and how `bundle install` tells a desktop about
// it. The containers are parsed back rather than trusted; the per-user setup
// for Linux and macOS runs against a scratch directory with the programs it
// would call replaced, so nothing here touches the machine's own desktop —
// and the macOS half runs everywhere, since what it writes is only files.
// The Windows half is registry work, which `windows.test.ts` does on Windows.

const tmp = scratch('desktop');
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

// A tiny but real PNG header of the given size: the writers read the IHDR.
function png(size: number, filler = 0): Buffer {
    const bytes = Buffer.alloc(40, filler);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12, 'latin1');
    bytes.writeUInt32BE(size, 16);
    bytes.writeUInt32BE(size, 20);
    return bytes;
}

// An .ico read back: the directory, and each entry's bytes.
function readIco(bytes: Buffer): { width: number; height: number; data: Buffer }[] {
    assert.equal(bytes.readUInt16LE(0), 0, 'reserved');
    assert.equal(bytes.readUInt16LE(2), 1, 'an icon, not a cursor');
    const count = bytes.readUInt16LE(4);
    return Array.from({ length: count }, (_, index) => {
        const at = 6 + 16 * index;
        const length = bytes.readUInt32LE(at + 8);
        const offset = bytes.readUInt32LE(at + 12);
        assert.ok(offset + length <= bytes.length, 'an entry runs past the end');
        return { width: bytes.readUInt8(at) || 256, height: bytes.readUInt8(at + 1) || 256, data: bytes.subarray(offset, offset + length) };
    });
}

// An .icns read back: its chunks, in order.
function readIcns(bytes: Buffer): [string, Buffer][] {
    assert.equal(bytes.toString('latin1', 0, 4), 'icns');
    assert.equal(bytes.readUInt32BE(4), bytes.length, 'the header gives the whole length');
    const chunks: [string, Buffer][] = [];
    for (let at = 8; at < bytes.length;) {
        const length = bytes.readUInt32BE(at + 4);
        assert.ok(length >= 8 && at + length <= bytes.length, 'a chunk runs past the end');
        chunks.push([bytes.toString('latin1', at, at + 4), bytes.subarray(at + 8, at + length)]);
        at += length;
    }
    return chunks;
}

test('an .ico is a directory of PNGs, 256 written as 0', () => {
    const images = [png(16, 1), png(48, 2), png(256, 3)];
    const bytes = ico(images);
    assert.equal(bytes[6 + 16 * 2], 0, 'a width of 256 does not fit a byte');
    const read = readIco(bytes);
    assert.deepEqual(read.map(({ width, height }) => [width, height]), [[16, 16], [48, 48], [256, 256]]);
    for (const [index, { data }] of read.entries()) assert.deepEqual(data, images[index]);

    assert.throws(() => ico([png(512)]), /at most 256/);
    assert.throws(() => ico([Buffer.from('not a png')]), /not a PNG/);
});

test('an .icns is typed chunks, big-endian, each length counting its header', () => {
    const bytes = icns([['icp4', png(16, 1)], ['ic10', png(1024, 2)]]);
    assert.deepEqual(readIcns(bytes).map(([type, data]) => [type, pngSize(data).width]), [['icp4', 16], ['ic10', 1024]]);
    assert.throws(() => icns([['toolong', png(16)]]), /four-character/);
});

test('the checked-in icons are the drawing, at every size the containers promise', () => {
    // `npm run icons` writes these; this is what notices one that is stale
    // against the lists, or hand-edited into something malformed.
    const entries = readIco(FS.readFileSync(PATH.join(ROOT, 'icons', 'nzip.ico')));
    assert.deepEqual(entries.map(({ width }) => width), [...ICO_SIZES]);
    for (const { width, data } of entries) assert.deepEqual(pngSize(data), { width, height: width });

    const chunks = readIcns(FS.readFileSync(PATH.join(ROOT, 'icons', 'nzip.icns')));
    assert.deepEqual(chunks.map(([type, data]) => [type, pngSize(data).width]), ICNS_TYPES.map(([type, size]) => [type, size]));

    const svg = FS.readFileSync(PATH.join(ROOT, 'icons', 'bundle.svg'), 'utf-8');
    assert.match(svg, /^<svg [^>]*viewBox="0 0 128 128"/);
    assert.doesNotMatch(svg, /href=|<text|<image|<filter/, 'the drawing stands alone, and renders anywhere');
    assert.equal(iconPath('bundle.svg'), PATH.join(ROOT, 'icons', 'bundle.svg'));
});

test('the icons ship: in the package, and in the bundled CLI', () => {
    const pkg = JSON.parse(FS.readFileSync(PATH.join(ROOT, 'package.json'), 'utf-8')) as { files: string[] };
    assert.ok(pkg.files.some((entry) => entry.replace(/\/$/, '') === 'icons'), `"files" lacks icons/: ${pkg.files.join(', ')}`);
    // The archive is built from the manifest tools/manifest.ts computes.
    assert.match(FS.readFileSync(PATH.join(ROOT, 'tools', 'manifest.ts'), 'utf-8'), /dirs: \[[^\]]*'icons'/);
});

test('the desktop setup can be turned off, by either name', () => {
    const kept = { desktop: process.env['BUNDLE_NO_DESKTOP_SETUP'], windows: process.env['BUNDLE_NO_WINDOWS_SETUP'] };
    try {
        delete process.env['BUNDLE_NO_DESKTOP_SETUP'];
        delete process.env['BUNDLE_NO_WINDOWS_SETUP'];
        assert.equal(desktopSetupWanted(), true);
        process.env['BUNDLE_NO_WINDOWS_SETUP'] = '1';
        assert.equal(desktopSetupWanted(), false, 'the older name still counts');
        delete process.env['BUNDLE_NO_WINDOWS_SETUP'];
        process.env['BUNDLE_NO_DESKTOP_SETUP'] = '1';
        assert.equal(desktopSetupWanted(), false);
    } finally {
        for (const [name, value] of [['BUNDLE_NO_DESKTOP_SETUP', kept.desktop], ['BUNDLE_NO_WINDOWS_SETUP', kept.windows]] as const) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test('the shared-mime-info package declares .nzip with its icon', () => {
    const xml = mimePackageXml();
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<mime-info xmlns="http:\/\/www\.freedesktop\.org\/standards\/shared-mime-info">/);
    assert.match(xml, new RegExp(`<mime-type type="${NZIP_MIME}">`));
    assert.match(xml, /<glob pattern="\*\.nzip"\/>/);
    // The icon name is the type with '-' for '/', which is what a theme looks up.
    assert.match(xml, /<icon name="application-x-nzip"\/>/);
    assert.match(xml, /<comment>[^<]+<\/comment>/);
    assert.equal((xml.match(/<mime-type /g) ?? []).length, (xml.match(/<\/mime-type>/g) ?? []).length);
});

test('the macOS Info.plist exports the type, with the icon, and opens nothing', () => {
    const plist = macInfoPlist();
    assert.match(plist, /<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN"/);
    const value = (key: string) => new RegExp(`<key>${key}</key>\\s*(<string>[^<]*</string>|<true/>|<array>.*?</array>)`).exec(plist)?.[1];
    assert.equal(value('CFBundleIdentifier'), '<string>com.pipobscure.bundle</string>');
    assert.equal(value('CFBundlePackageType'), '<string>APPL</string>');
    assert.equal(value('CFBundleExecutable'), '<string>NodeBundle</string>');
    assert.equal(value('LSUIElement'), '<true/>');
    assert.equal(value('UTTypeIdentifier'), `<string>${NZIP_UTI}</string>`);
    assert.equal(value('UTTypeIconFile'), '<string>nzip.icns</string>');
    assert.equal(value('UTTypeConformsTo'), '<array><string>public.data</string><string>public.archive</string></array>');
    assert.equal(value('public.filename-extension'), '<array><string>nzip</string></array>');
    assert.equal(value('CFBundleTypeRole'), '<string>None</string>', 'never offered to open one with');
    assert.equal(value('LSItemContentTypes'), `<array><string>${NZIP_UTI}</string></array>`);
    // Balanced, which is most of what a plist parser asks.
    for (const tag of ['dict', 'array', 'plist']) {
        assert.equal((plist.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length, (plist.match(new RegExp(`</${tag}>`, 'g')) ?? []).length, tag);
    }
});

// A stand-in for the programs the setup runs: it records what was asked, and
// answers as if each were installed, or missing.
function runner(missing: string[] = []): Runner & { calls: string[][] } {
    const calls: string[][] = [];
    const fake = (command: string, args: string[]) => {
        calls.push([PATH.basename(command), ...args]);
        if (missing.includes(PATH.basename(command))) {
            return { status: null, error: Object.assign(new Error(`spawnSync ${command} ENOENT`), { code: 'ENOENT' }) };
        }
        return { status: 0 };
    };
    return Object.assign(fake, { calls });
}

test('Linux: the type and its icon go under XDG_DATA_HOME, once', () => {
    const dataHome = PATH.join(tmp, 'linux', 'share');
    const run = runner();
    const notes = ensureFreedesktopFileType({ dataHome, runner: run });
    assert.deepEqual(notes, ['registered the .nzip file type and its icon, for this user']);

    assert.equal(FS.readFileSync(PATH.join(dataHome, 'mime', 'packages', 'pipobscure-bundle-nzip.xml'), 'utf-8'), mimePackageXml());
    assert.deepEqual(FS.readFileSync(PATH.join(dataHome, 'icons', 'hicolor', 'scalable', 'mimetypes', 'application-x-nzip.svg')),
        FS.readFileSync(PATH.join(ROOT, 'icons', 'bundle.svg')));
    // No icon cache there yet, so none is made — see ensureFreedesktopFileType.
    assert.deepEqual(run.calls, [['update-mime-database', PATH.join(dataHome, 'mime')]]);

    // Everything already right: nothing written, nothing run, nothing said.
    const again = runner();
    assert.deepEqual(ensureFreedesktopFileType({ dataHome, runner: again }), []);
    assert.deepEqual(again.calls, []);
});

test('Linux: an existing icon cache is kept current; a missing tool is a note', () => {
    const dataHome = PATH.join(tmp, 'linux-cached', 'share');
    const hicolor = PATH.join(dataHome, 'icons', 'hicolor');
    FS.mkdirSync(hicolor, { recursive: true });
    FS.writeFileSync(PATH.join(hicolor, 'icon-theme.cache'), '');

    const run = runner(['update-mime-database']);
    const notes = ensureFreedesktopFileType({ dataHome, runner: run });
    assert.deepEqual(run.calls, [
        ['update-mime-database', PATH.join(dataHome, 'mime')],
        ['gtk-update-icon-cache', '-q', '-t', hicolor],
    ]);
    assert.equal(notes[0], 'registered the .nzip file type and its icon, for this user');
    assert.match(notes[1] ?? '', /update-mime-database .*\(it is not installed here\)$/);
    assert.equal(notes.length, 2);

    // A changed icon is written again, and the databases asked again.
    FS.writeFileSync(PATH.join(hicolor, 'scalable', 'mimetypes', 'application-x-nzip.svg'), '<svg/>');
    const after = runner();
    assert.deepEqual(ensureFreedesktopFileType({ dataHome, runner: after }), ['registered the .nzip file type and its icon, for this user']);
    assert.equal(after.calls.length, 2);
});

test('Linux: the real update-mime-database, when this machine has one', (t) => {
    // Not a stand-in: the package has to be one the real tool accepts. Run
    // against the scratch directory, never the user's own.
    const dataHome = PATH.join(tmp, 'linux-real', 'share');
    const notes = ensureFreedesktopFileType({ dataHome });
    if (notes.some((note) => note.includes('not installed'))) {
        t.skip('update-mime-database is not installed here');
        return;
    }
    assert.deepEqual(notes, ['registered the .nzip file type and its icon, for this user']);
    const globs = FS.readFileSync(PATH.join(dataHome, 'mime', 'globs2'), 'utf-8');
    assert.match(globs, /application\/x-nzip:\*\.nzip/);
    const icons = FS.readFileSync(PATH.join(dataHome, 'mime', 'icons'), 'utf-8');
    assert.match(icons, /application\/x-nzip:application-x-nzip/);
});

test('macOS: an app that declares the type, registered with Launch Services once', () => {
    const home = PATH.join(tmp, 'mac');
    const app = macAppDir(home);
    assert.equal(app, PATH.join(home, 'Library', 'Application Support', 'bundle', 'NodeBundle.app'));

    const run = runner();
    assert.deepEqual(ensureMacFileType({ home, runner: run }), ['registered the .nzip file type and its icon, for this user']);
    assert.equal(FS.readFileSync(PATH.join(app, 'Contents', 'Info.plist'), 'utf-8'), macInfoPlist());
    assert.deepEqual(FS.readFileSync(PATH.join(app, 'Contents', 'Resources', 'nzip.icns')), FS.readFileSync(PATH.join(ROOT, 'icons', 'nzip.icns')));
    const executable = PATH.join(app, 'Contents', 'MacOS', 'NodeBundle');
    assert.match(FS.readFileSync(executable, 'utf-8'), /^#!\/bin\/sh\n/);
    if (process.platform !== 'win32') assert.equal(FS.statSync(executable).mode & 0o777, 0o755);
    assert.deepEqual(run.calls, [['lsregister', '-f', app]]);

    const again = runner();
    assert.deepEqual(ensureMacFileType({ home, runner: again }), []);
    assert.deepEqual(again.calls, []);

    // Launch Services refusing is a note, not an exception.
    FS.rmSync(app, { recursive: true });
    const failing: Runner = () => ({ status: 1, stderr: 'lsregister: no\n' });
    assert.deepEqual(ensureMacFileType({ home, runner: failing }), [`wrote ${app}, but could not register it with Launch Services (lsregister: no)`]);
});
