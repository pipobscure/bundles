import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as ZLIB from 'node:zlib';
import {
    checkSource, declarationProblem, execArg, fileTitle, idOf, make, planFor, psQuote, readDeclaration, readIcons, shQuote, takeAway,
    MAC_ID_PREFIX, type AppDeclaration, type Places, type Runner,
} from '../src/app-entry.ts';
import { scratch } from './helpers.ts';

// An app's entry in the desktop's applications: what its package.json may
// ask for, what each platform's plan writes — quoted for where it goes — and
// carrying a plan out without ever replacing what is not bundle's. Every
// platform's plan is checked here, wherever this runs; nothing touches the
// machine's own desktop.

const tmp = scratch('app-entry');
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

/** A zip of these members, made with node:zlib, as an archive's bytes would be. */
async function zip(members: Record<string, string | Buffer>): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const entries = Object.entries(members).map(([name, data]) => ZLIB.ZipEntry.createSync(name, Buffer.from(data)));
    for await (const chunk of ZLIB.createZipArchive(entries)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
}
const pkg = (app: unknown) => JSON.stringify({ name: 'demo', bundle: { app } });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const ICNS = (() => { const b = Buffer.alloc(16); b.write('icns', 0, 'latin1'); b.writeUInt32BE(16, 4); return b; })();
const ICO = (() => { const b = Buffer.alloc(22); b.writeUInt16LE(1, 2); b.writeUInt16LE(1, 4); return b; })();
const SVG = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';

test('an app asks for an entry in its package.json, under bundle.app, and only title is required', async () => {
    assert.deepEqual(readDeclaration(await zip({ 'package.json': JSON.stringify({ name: 'demo' }) })), {}, 'asks for none');
    assert.deepEqual(readDeclaration(await zip({ 'index.js': '' })), {}, 'no package.json');
    assert.deepEqual(readDeclaration(await zip({ 'package.json': pkg({ title: ' Demo ' }) })), {
        app: { title: 'Demo', description: undefined, args: [], categories: [], icons: {} },
    });
    const full = { title: 'Demo', description: 'A demo', args: ['--window'], categories: ['Network'], icons: { svg: 'icon.svg' } };
    assert.deepEqual(readDeclaration(await zip({ 'package.json': pkg(full) })).app, full);
});

test('a declaration that is not one says why, and a typo is not silently ignored', () => {
    assert.match(declarationProblem({ title: 'Demo', icon: 'x.png' })!, /unknown field 'icon' \(it takes title, description, args, categories, icons\)/);
    assert.match(declarationProblem({})!, /title must be/);
    assert.match(declarationProblem({ title: 'x'.repeat(65) })!, /title must be/);
    assert.match(declarationProblem({ title: 'two\nlines' })!, /title must be/);
    assert.match(declarationProblem({ title: 'Demo', args: ['ok', 'no\nnewlines'] })!, /args must be/);
    assert.match(declarationProblem({ title: 'Demo', categories: ['Not;Allowed'] })!, /categories must be/);
    assert.match(declarationProblem({ title: 'Demo', icons: { gif: 'a.gif' } })!, /icons\.gif: not a format/);
    assert.match(declarationProblem({ title: 'Demo', icons: { png: '../outside.png' } })!, /icons\.png must be the path of a file in the archive/);
    assert.match(declarationProblem({ title: 'Demo', icons: { png: '/abs.png' } })!, /icons\.png must be/);
    assert.equal(declarationProblem({ title: 'Demo', description: 'fine', args: [], categories: ['Utility'], icons: { png: 'a/b.png' } }), undefined);
});

test('an icon counts when it is in the archive and starts the way its format does', async () => {
    const bytes = await zip({ 'package.json': '{}', 'i.png': PNG, 'i.icns': ICNS, 'i.ico': ICO, 'i.svg': SVG, 'fake.png': 'not a png' });
    const app: AppDeclaration = { title: 'Demo', args: [], categories: [], icons: { png: 'i.png', icns: 'i.icns', ico: 'i.ico', svg: 'i.svg' } };
    const { icons, notes } = readIcons(bytes, app);
    assert.deepEqual(Object.keys(icons).sort(), ['icns', 'ico', 'png', 'svg']);
    assert.deepEqual(notes, []);
    const wrong = readIcons(bytes, { ...app, icons: { png: 'fake.png', ico: 'missing.ico', icns: 'i.png' } });
    assert.deepEqual(wrong.icons, {});
    assert.deepEqual(wrong.notes, ['icons.png: fake.png is not a PNG file', 'icons.ico: the archive has no missing.ico', 'icons.icns: i.png is not an ICNS file']);
});

test('names become file names every system takes', () => {
    assert.equal(idOf('davsync'), 'davsync');
    assert.equal(idOf('Dav Sync.nzip'), 'dav-sync');
    assert.equal(idOf('..'), 'app');
    assert.equal(fileTitle('A/B: "C"?'), 'A-B- -C--');
    assert.equal(fileTitle('  .hidden. '), 'hidden');
    assert.equal(fileTitle('CON'), 'CON App');
});

test('quoting: Exec= twice over and % doubled, sh single quotes, PowerShell single quotes', () => {
    assert.equal(execArg('/home/u/.local/share/bundle/apps/demo.nzip'), '"/home/u/.local/share/bundle/apps/demo.nzip"');
    // The spec's quoting escapes " ` $ \ with a backslash; the string type then escapes every backslash again.
    assert.equal(execArg('a "b" $c `d` \\e 100%'), '"a \\\\"b\\\\" \\\\$c \\\\`d\\\\` \\\\\\\\e 100%%"');
    assert.equal(shQuote("it's"), `'it'\\''s'`);
    assert.equal(psQuote("it's"), "'it''s'");
});

const places = (root: string, platform: NodeJS.Platform): Places => ({
    platform,
    home: PATH.join(root, 'home'),
    dataHome: PATH.join(root, 'home', '.local', 'share'),
    appData: PATH.join(root, 'Roaming'),
    localAppData: PATH.join(root, 'Local'),
});
const app: AppDeclaration = { title: 'Dav "Sync"', description: 'Sync & <more>', args: ['--window', 'two words'], categories: ['Network', 'FileTransfer'], icons: {} };

test('on Linux: a desktop entry that runs the archive, with its icon by absolute path', () => {
    const at = places('/r', 'linux');
    const plan = planFor({ name: 'davsync', app, icons: { svg: Buffer.from(SVG), png: PNG }, archive: '/r/apps/dav sync.nzip', places: at })!;
    assert.equal(plan.entry, '/r/home/.local/share/applications/bundle-davsync.desktop');
    const text = plan.files[0]!.content.toString();
    assert.match(text, /^\[Desktop Entry\]\n/);
    assert.match(text, /^Name=Dav "Sync"$/m);
    assert.match(text, /^Comment=Sync & <more>$/m);
    assert.match(text, /^Exec="\/r\/apps\/dav sync\.nzip" "--window" "two words"$/m);
    assert.match(text, /^Icon=\/r\/home\/\.local\/share\/bundle\/icons\/davsync\.svg$/m, 'the SVG over the PNG');
    assert.match(text, /^Categories=Network;FileTransfer;$/m);
    assert.match(text, /^X-Bundle-Name=davsync$/m);
    assert.deepEqual(plan.files[1]!.content, Buffer.from(SVG));
    assert.deepEqual(plan.remove, [plan.entry, '/r/home/.local/share/bundle/icons/davsync.svg']);
    assert.deepEqual(plan.commands, []);
});

test('on macOS: an app in ~/Applications, its plist escaped, its script quoted', () => {
    const at = places('/r', 'darwin');
    const plan = planFor({ name: 'davsync', app, icons: { icns: ICNS }, archive: "/r/it's/davsync.nzip", places: at })!;
    assert.equal(plan.entry, '/r/home/Applications/Dav -Sync-.app');
    const plist = plan.files.find((file) => file.path.endsWith('Info.plist'))!.content.toString();
    assert.match(plist, new RegExp(`<key>CFBundleIdentifier</key><string>${MAC_ID_PREFIX.replace(/\./g, '\\.')}davsync</string>`));
    assert.match(plist, /<key>CFBundleName<\/key><string>Dav &quot;Sync&quot;<\/string>/);
    assert.match(plist, /<string>Sync &amp; &lt;more&gt;<\/string>/);
    assert.match(plist, /<key>CFBundleIconFile<\/key><string>AppIcon\.icns<\/string>/);
    const script = plan.files.find((file) => file.path.endsWith('/MacOS/davsync'))!;
    assert.equal(script.mode, 0o755);
    assert.match(script.content.toString(), /^exec '\/r\/it'\\''s\/davsync\.nzip' '--window' 'two words' "\$@"$/m);
    assert.ok(plan.files.some((file) => file.path.endsWith('/Resources/AppIcon.icns')));
    assert.deepEqual(plan.remove, [plan.entry]);
    assert.match(plan.commands[0]![0]!, /lsregister$/);
});

test('on Windows: a hidden PowerShell runs node with the archive, from a Start menu shortcut', () => {
    const at = places('C:\\r', 'win32');
    assert.equal(planFor({ name: 'davsync.nzip', app, icons: {}, archive: 'C:\\b\\davsync.nzip', places: at }), undefined, 'no node to run it with: no shortcut');
    const plan = planFor({ name: 'davsync.nzip', app, icons: { ico: ICO }, archive: "C:\\b\\it's\\davsync.nzip", node: 'C:\\node\\node.exe', places: at })!;
    assert.match(plan.entry, /Start Menu\\Programs\\Dav -Sync-\.lnk$/);
    const script = plan.files[0]!.content.toString();
    assert.match(script, /^& 'C:\\node\\node\.exe' '--no-warnings' '--experimental-vfs' '--vfs-load=C:\\b\\it''s\\davsync\.nzip' '--' '--window' 'two words' @args\r$/m);
    const [command] = plan.commands;
    assert.equal(command![0], 'powershell.exe');
    assert.match(command![4]!, /CreateShortcut\('C:\\r\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Dav -Sync-\.lnk'\)/);
    assert.match(command![4]!, /-WindowStyle Hidden -File "C:\\r\\Local\\bundle\\apps\\davsync\.ps1"/);
    assert.match(command![4]!, /\$shortcut\.IconLocation = 'C:\\r\\Local\\bundle\\icons\\davsync\.ico,0'/);
    assert.match(command![4]!, /\$shortcut\.Description = 'Sync & <more>'/);
    assert.equal(plan.remove.length, 3, 'the shortcut, the script and the icon');
});

const runner: Runner = () => ({ status: 0 });

test('making an entry writes its plan; what is there and not bundle\'s is left alone', () => {
    const root = PATH.join(tmp, 'make');
    const at = places(root, 'linux');
    const plan = planFor({ name: 'demo', app: { ...app, title: 'Demo' }, icons: { png: PNG }, archive: '/x/demo.nzip', places: at })!;
    const made = make(plan, { name: 'demo', runner, places: at });
    assert.deepEqual(made.notes, []);
    assert.deepEqual(made.paths, plan.remove);
    assert.ok(FS.readFileSync(plan.entry, 'utf-8').includes('Exec="/x/demo.nzip"'));

    // Made again — an update — replaces it.
    assert.deepEqual(make(plan, { name: 'demo', runner, places: at }).paths, plan.remove);

    // Something else's, where ours would go: left alone, and said.
    FS.writeFileSync(plan.entry, '[Desktop Entry]\nName=Someone else\n');
    const refused = make(plan, { name: 'demo', runner, places: at });
    assert.deepEqual(refused.paths, []);
    assert.match(refused.notes[0]!, /which bundle did not make; no desktop entry for demo/);
    assert.equal(FS.readFileSync(plan.entry, 'utf-8'), '[Desktop Entry]\nName=Someone else\n');
    // ...unless it is the one this install made before.
    assert.deepEqual(make(plan, { name: 'demo', runner, places: at, ours: [plan.entry] }).paths, plan.remove);
});

test('a renamed title moves the app: the old one, being ours, goes', () => {
    const root = PATH.join(tmp, 'rename');
    const at = places(root, 'darwin');
    const before = planFor({ name: 'demo', app: { ...app, title: 'Old' }, icons: {}, archive: '/x/demo.nzip', places: at })!;
    const first = make(before, { name: 'demo', runner, places: at });
    assert.ok(FS.existsSync(PATH.join(before.entry, 'Contents', 'Info.plist')));
    const after = planFor({ name: 'demo', app: { ...app, title: 'New' }, icons: {}, archive: '/x/demo.nzip', places: at })!;
    make(after, { name: 'demo', runner, places: at, ours: first.paths });
    assert.equal(FS.existsSync(before.entry), false);
    assert.ok(FS.existsSync(after.entry));
    // An app of the same title that bundle wrote for another name is not this one's.
    const other = planFor({ name: 'other', app: { ...app, title: 'New' }, icons: {}, archive: '/x/other.nzip', places: at })!;
    assert.match(make(other, { name: 'other', runner, places: at }).notes[0]!, /did not make; no application for other/);
});

test('a failed command is a note, not a failure', () => {
    const at = places(PATH.join(tmp, 'failing'), 'darwin');
    const plan = planFor({ name: 'demo', app: { ...app, title: 'Demo' }, icons: {}, archive: '/x/demo.nzip', places: at })!;
    const made = make(plan, { name: 'demo', runner: () => ({ status: null, error: Object.assign(new Error('no'), { code: 'ENOENT' }) }), places: at });
    assert.deepEqual(made.paths, plan.remove);
    assert.deepEqual(made.notes, ['lsregister did not finish making the application (it is not installed here)']);
});

test('taking an entry away removes only what is inside the directories entries are made in', () => {
    const root = PATH.join(tmp, 'take');
    const at = places(root, 'linux');
    const inside = PATH.join(at.dataHome, 'applications', 'bundle-demo.desktop');
    const outside = PATH.join(root, 'precious.txt');
    for (const path of [inside, outside]) { FS.mkdirSync(PATH.dirname(path), { recursive: true }); FS.writeFileSync(path, 'x'); }
    assert.deepEqual(takeAway([inside, outside, PATH.join(at.dataHome, 'applications')], at), [inside]);
    assert.ok(FS.existsSync(outside));
    assert.ok(FS.existsSync(PATH.join(at.dataHome, 'applications')), 'not the directory itself');
});

test('create says, from the files it packs, what entry an install will make', () => {
    const base = PATH.join(tmp, 'source');
    FS.mkdirSync(PATH.join(base, 'icons'), { recursive: true });
    FS.writeFileSync(PATH.join(base, 'icons', 'app.svg'), SVG);
    FS.writeFileSync(PATH.join(base, 'icons', 'app.ico'), 'not an ico');
    const write = (app: unknown) => FS.writeFileSync(PATH.join(base, 'package.json'), pkg(app));

    write({ title: 'Demo', icons: { svg: 'icons/app.svg', ico: 'icons/app.ico', icns: 'icons/app.icns' } });
    const checked = checkSource(base, ['package.json', 'icons/app.svg', 'icons/app.ico']);
    assert.equal(checked.app?.title, 'Demo');
    assert.deepEqual(checked.formats, ['svg']);
    assert.deepEqual(checked.problems, [
        'icons.ico: icons/app.ico is not an ICO file',
        'icons.icns: icons/app.icns is not in the file list',
        'no icon for macOS (icns), Windows (ico): the entry there has none',
    ]);

    write({ title: 'Demo', iconz: {} });
    assert.deepEqual(checkSource(base, ['package.json']).problems, ["package.json bundle.app: unknown field 'iconz' (it takes title, description, args, categories, icons)"]);
    FS.writeFileSync(PATH.join(base, 'package.json'), JSON.stringify({ name: 'plain' }));
    assert.deepEqual(checkSource(base, ['package.json']), { formats: [], problems: [] });
});
