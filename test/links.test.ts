import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { appleScriptHandler, desktopHandler, linkFor, readLink, windowsHandlerCommand, windowsHandlerScript } from '../src/links.ts';
import { ensureLinkHandler, linkHandlerProblems, removeLinkHandler, macLinksApp } from '../src/install.ts';
import { scratch } from './helpers.ts';

// nzip: links, which any page can make: read strictly, as a published name only.

const did = 'did:plc:abcdefghijklmnopqrstuvwx';
const targetOf = (link: string) => readLink(link).target;

test('a link is a listing or suite by handle, DID or at:// address, and means what install takes', () => {
    assert.equal(targetOf('nzip:alice.example/devtools'), '@alice.example/devtools');
    assert.equal(targetOf('NZIP:Alice.Example/devtools'), '@alice.example/devtools', 'the scheme and the handle in any case; the name as given');
    assert.equal(targetOf('nzip://alice.example/devtools'), '@alice.example/devtools');
    assert.equal(targetOf(`nzip:${did}/devtools`), `@${did}/devtools`);
    assert.equal(targetOf(`nzip:${encodeURIComponent(did)}%2Fdevtools`), `@${did}/devtools`, 'decoded once, then checked');
    assert.equal(targetOf(`nzip:at://${did}/com.pipobscure.bundle.suite/devtools`), `at://${did}/com.pipobscure.bundle.suite/devtools`);
});

test('anything else is refused: URLs, domains, paths, options, extras', () => {
    for (const link of [
        'nzip:https://evil.example/x.nzip', 'nzip:evil.example', 'nzip:alice.example/', 'nzip:alice.example/a/b', 'nzip:../etc/passwd',
        'nzip:--yes', 'nzip:alice.example/--yes x', 'nzip:alice.example/devtools?yes=1', 'nzip:alice.example/devtools#x',
        'nzip:alice.example/dev%0Atools', 'nzip:%E0%A4%A', 'nzip:at://alice.example/com.x.y/z', `nzip:at://${did}/x/y`,
        'https://alice.example/devtools', 'nzip:did:plc:short/x',
    ]) assert.throws(() => targetOf(link), /link/, link);
});

test('a link may say which app a plugin goes in, as --for would, and nothing else', () => {
    assert.deepEqual(readLink('nzip:alice.example/devtools'), { target: '@alice.example/devtools' });
    assert.deepEqual(readLink('nzip:alice.example/bled-gpio?for=bled'), { target: '@alice.example/bled-gpio', for: 'bled' });
    assert.deepEqual(readLink('nzip:alice.example/bled-gpio?for=@acme/editor'), { target: '@alice.example/bled-gpio', for: '@acme/editor' });
    assert.deepEqual(readLink('nzip:alice.example/bled-gpio?for=%40pipobscure.com%2Fbled'), { target: '@alice.example/bled-gpio', for: '@pipobscure.com/bled' },
        'decoded once, then checked');
    assert.deepEqual(readLink(`nzip:alice.example/bled-gpio?for=@${did}/bled`), { target: '@alice.example/bled-gpio', for: `@${did}/bled` });
    assert.deepEqual(readLink(`nzip:at://${did}/com.pipobscure.bundle.listing/bled-gpio?for=at://${did}/com.pipobscure.bundle.listing/bled`),
        { target: `at://${did}/com.pipobscure.bundle.listing/bled-gpio`, for: `at://${did}/com.pipobscure.bundle.listing/bled` });

    for (const link of [
        'nzip:alice.example/bled-gpio?for=', 'nzip:alice.example/bled-gpio?for', 'nzip:alice.example/bled-gpio?', 'nzip:alice.example/bled-gpio?FOR=bled',
        'nzip:alice.example/bled-gpio?for=bled&yes=1', 'nzip:alice.example/bled-gpio?for=bled&for=other', 'nzip:alice.example/bled-gpio?yes=1&for=bled',
        'nzip:alice.example/bled-gpio?for=bled#x', 'nzip:alice.example/bled-gpio?for=bled?x', 'nzip:alice.example/bled-gpio?for=Bled',
        'nzip:alice.example/bled-gpio?for=--yes', 'nzip:alice.example/bled-gpio?for=../etc', 'nzip:alice.example/bled-gpio?for=%2E%2E%2Fetc',
        'nzip:alice.example/bled-gpio?for=bled%0A', 'nzip:alice.example/bled-gpio?for=%E0%A4%A', 'nzip:alice.example/bled-gpio?for=https://evil.example/x',
        'nzip:alice.example/bled-gpio?for=~/x', 'nzip:alice.example/bled-gpio?for=@alice.example/a/b', `nzip:alice.example/bled-gpio?for=at://${did}/x.y.z/bled`,
        `nzip:alice.example/bled-gpio?for=${'a'.repeat(215)}`, 'nzip:alice.example/bled-gpio%3Ffor=bled',
    ]) assert.throws(() => readLink(link), /link/, link);
});

test('a link is written for what install takes', () => {
    assert.equal(linkFor('@alice.example/devtools'), 'nzip:alice.example/devtools');
    assert.equal(linkFor(`at://${did}/com.pipobscure.bundle.suite/devtools`), `nzip:at://${did}/com.pipobscure.bundle.suite/devtools`);
    assert.equal(targetOf(linkFor('@alice.example/devtools')), '@alice.example/devtools');
});

// ------------------------------------------------------------ the handler ---

const tmp = scratch('links');
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

test('each platform\'s handler passes the link on as one argument, after --, never into a command line', () => {
    const desktop = desktopHandler('/home/u/.local/share/bundle/apps/bundle.nzip');
    assert.match(desktop, /^Exec="\/home\/u\/\.local\/share\/bundle\/apps\/bundle\.nzip" install --window -- %u$/m);
    assert.match(desktop, /^MimeType=x-scheme-handler\/nzip;$/m);
    assert.match(desktop, /^NoDisplay=true$/m);

    const script = appleScriptHandler('/Users/u/it\'s "here"/bundle.nzip');
    assert.match(script, /^on open location theURL$/m);
    assert.ok(script.includes('quoted form of "/Users/u/it\'s \\"here\\"/bundle.nzip" & " install --window -- " & quoted form of theURL'), script);

    const ps1 = windowsHandlerScript('C:\\node\\node.exe', "C:\\it's\\bundle.nzip");
    assert.match(ps1, /^if \(\$args\.Count -ne 1\) \{ exit 64 \}\r$/m);
    assert.match(ps1, /^& 'C:\\node\\node\.exe' '--no-warnings' '--experimental-vfs' '--vfs-load=C:\\it''s\\bundle\.nzip' '--' 'install' '--window' '--' \$args\[0\]\r$/m);
    assert.equal(windowsHandlerCommand('C:\\b\\links.ps1'), 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\b\\links.ps1" "%1"');
});

test('installing bundle registers the handler once, and uninstalling it takes it away', { skip: process.platform === 'win32' && 'registry work; the command and script are checked above' }, () => {
    const ran: string[][] = [];
    const runner = (command: string, args: string[]) => { ran.push([PATH.basename(command), ...args]); return { status: 0 }; };
    const home = PATH.join(tmp, 'home');
    const dataHome = PATH.join(home, '.local', 'share');
    const archive = PATH.join(dataHome, 'bundle', 'apps', 'bundle.nzip');

    assert.deepEqual(ensureLinkHandler(archive, { runner, home, dataHome }), ['nzip: links now open bundle, for this user']);
    if (process.platform === 'darwin') {
        assert.deepEqual(ran.map((each) => each[0]), ['osacompile', 'plutil', 'plutil', 'plutil', 'plutil', 'codesign', 'lsregister']);
        assert.ok(ran[4]!.includes(JSON.stringify([{ CFBundleURLName: 'nzip install link', CFBundleURLSchemes: ['nzip'] }])));
    } else {
        assert.ok(FS.readFileSync(PATH.join(dataHome, 'applications', 'bundle-nzip-links.desktop'), 'utf-8').includes('install --window -- %u'));
        assert.deepEqual(ran[0], ['xdg-mime', 'default', 'bundle-nzip-links.desktop', 'x-scheme-handler/nzip']);
    }
    // Again, for the same archive: nothing to do — on macOS, once the applet is there.
    if (process.platform === 'darwin') FS.mkdirSync(PATH.join(macLinksApp(home), 'Contents'), { recursive: true }), FS.writeFileSync(PATH.join(macLinksApp(home), 'Contents', 'Info.plist'), '');
    ran.length = 0;
    assert.deepEqual(ensureLinkHandler(archive, { runner, home, dataHome }), []);
    assert.deepEqual(ran, []);

    removeLinkHandler({ runner, home, dataHome });
    assert.equal(FS.existsSync(PATH.join(dataHome, 'applications', 'bundle-nzip-links.desktop')), false);
    assert.equal(FS.existsSync(macLinksApp(home)), false);
});

test('a step that fails leaves no half-made applet behind', { skip: process.platform !== 'darwin' && 'the applet is macOS\'s' }, () => {
    const home = PATH.join(tmp, 'home-failing');
    const notes = ensureLinkHandler('/x/bundle.nzip', { home, runner: (command) => (command === 'codesign' ? { status: 1, stderr: 'no' } : { status: 0 }) });
    assert.deepEqual(notes, ['could not register nzip: links: codesign no']);
    assert.equal(FS.existsSync(macLinksApp(home)), false);
});

test('what keeps links from opening bundle is said, and repairing does every step again', { skip: process.platform !== 'linux' && 'the Linux handler; the others are registry and Launch Services work' }, () => {
    const home = PATH.join(tmp, 'home-check');
    const dataHome = PATH.join(home, '.local', 'share');
    const archive = PATH.join(dataHome, 'bundle', 'apps', 'bundle.nzip');
    let preferred = 'other-browser.desktop';
    const ran: string[][] = [];
    const runner = (command: string, args: string[]) => {
        ran.push([command, ...args]);
        if (args[0] === 'query') return { status: 0, stdout: `${preferred}\n` };
        if (args[0] === 'default') preferred = args[1]!;
        return { status: 0 };
    };
    assert.deepEqual(linkHandlerProblems(archive, { runner, home, dataHome }), [
        `the bundle they would open, ${archive}, is not there`,
        `${PATH.join(dataHome, 'applications', 'bundle-nzip-links.desktop')} is missing, or opens something else`,
        'other-browser.desktop opens them instead',
    ]);
    FS.mkdirSync(PATH.dirname(archive), { recursive: true });
    FS.writeFileSync(archive, '');
    ensureLinkHandler(archive, { runner, home, dataHome });
    assert.deepEqual(linkHandlerProblems(archive, { runner, home, dataHome }), []);

    // Something else takes the scheme; the entry is unchanged, so only a forced registration sets the default again.
    preferred = 'other-browser.desktop';
    ran.length = 0;
    assert.deepEqual(ensureLinkHandler(archive, { runner, home, dataHome }), []);
    assert.deepEqual(ran, []);
    ensureLinkHandler(archive, { runner, home, dataHome, force: true });
    assert.equal(preferred, 'bundle-nzip-links.desktop');
});
