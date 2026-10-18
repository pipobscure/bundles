import * as FS from 'node:fs';
import * as OS from 'node:os';
import * as PATH from 'node:path';
import * as ZLIB from 'node:zlib';

// An app's entry in the desktop's list of applications: what makes an
// installed bundle something a person opens from a menu, Launchpad or Start,
// with its own name and icon, rather than a command they type.
//
// The app asks for one in its own package.json, which is inside the signed
// archive — so the name and the icon a menu shows are covered by the same
// signature, and accepted with the same decision, as the code:
//
//   "bundle": {
//     "app": {
//       "title": "davsync",
//       "description": "Two-way sync of folders with WebDAV",
//       "args": [],
//       "categories": ["Network", "FileTransfer"],
//       "icons": { "svg": "public/icon.svg", "png": "public/icon-512.png",
//                  "icns": "public/icon.icns", "ico": "public/icon.ico" }
//     }
//   }
//
// Only `title` is required. Each icon is a member of the archive, in the
// format its key names: Linux takes the SVG, else the PNG; macOS the .icns;
// Windows the .ico. Nothing is converted or rendered at install — an icon
// the platform's format is missing for is simply not shown there.
//
// What is written, for the current user only, follows the shape davsync uses
// for starting at login: a plan of files and commands, worked out without
// touching anything (so every platform's can be tested anywhere), then
// carried out. Every value from the declaration is quoted for the file it
// goes into, and the command an entry runs is bundle's own — the installed
// archive, with the declared arguments after it — never a string the app
// wrote.
//
//   Linux    $XDG_DATA_HOME/applications/bundle-<name>.desktop, and its icon
//            in bundle's data directory, named by absolute path
//   macOS    ~/Applications/<title>.app: an Info.plist, a two-line script
//            that runs the archive, and the .icns; then `lsregister`
//   Windows  a Start menu shortcut, through WScript.Shell, to a hidden
//            PowerShell running the script that runs node with the archive
//            mounted — node is a console program, and an app opened from
//            Start should not bring a console window with it
//
// Nothing that is already there and not bundle's is replaced: an app of the
// same title from somewhere else keeps its place, and this one is said to
// have none.

/** What an app's package.json asks for under `bundle.app`. */
export interface AppDeclaration {
    title: string;
    description?: string | undefined;
    args: string[];
    categories: string[];
    icons: Partial<Record<IconFormat, string>>;
}

export type IconFormat = 'svg' | 'png' | 'icns' | 'ico';
const FORMATS: readonly IconFormat[] = ['svg', 'png', 'icns', 'ico'];
const KIND: Record<IconFormat, string> = { svg: 'an SVG', png: 'a PNG', icns: 'an ICNS', ico: 'an ICO' };

/** The largest icon file read out of an archive. */
export const MAX_ICON = 4 * 1024 * 1024;

const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The entry an archive asks for: its declaration, or why it is not one, or
 * neither when it asks for none. Reading it runs nothing.
 */
export function readDeclaration(bytes: Buffer): { app?: AppDeclaration | undefined; problem?: string | undefined } {
    let pkg: unknown;
    try {
        const zip = new ZLIB.ZipBuffer(bytes);
        if (!zip.has('package.json')) return {};
        pkg = JSON.parse(zip.get('package.json').contentSync().toString('utf-8'));
    } catch {
        return {};
    }
    const app = (pkg as { bundle?: { app?: unknown } } | null)?.bundle?.app;
    if (app === undefined) return {};
    const problem = declarationProblem(app);
    if (problem) return { problem: `package.json bundle.app: ${problem}` };
    const given = app as Partial<AppDeclaration>;
    return {
        app: {
            title: given.title!.trim(),
            description: given.description?.trim() || undefined,
            args: given.args ?? [],
            categories: given.categories ?? [],
            icons: given.icons ?? {},
        },
    };
}

/** What is wrong with a `bundle.app` declaration, or undefined when nothing is. */
export function declarationProblem(app: unknown): string | undefined {
    if (typeof app !== 'object' || app === null || Array.isArray(app)) return 'not an object';
    const known = ['title', 'description', 'args', 'categories', 'icons'];
    const unknown = Object.keys(app).filter((key) => !known.includes(key));
    if (unknown.length) return `unknown ${unknown.length > 1 ? 'fields' : 'field'} ${unknown.map((key) => `'${key}'`).join(', ')} (it takes ${known.join(', ')})`;
    const { title, description, args, categories, icons } = app as Record<string, unknown>;
    if (typeof title !== 'string' || !title.trim() || title.length > 64 || CONTROL.test(title)) return 'title must be a name of 1 to 64 characters, on one line';
    if (description !== undefined && (typeof description !== 'string' || description.length > 200 || CONTROL.test(description))) return 'description must be at most 200 characters, on one line';
    if (args !== undefined && (!Array.isArray(args) || args.length > 16 || !args.every((arg) => typeof arg === 'string' && arg.length <= 256 && !CONTROL.test(arg)))) {
        return 'args must be at most 16 strings, each on one line';
    }
    if (categories !== undefined && (!Array.isArray(categories) || categories.length > 8 || !categories.every((each) => typeof each === 'string' && /^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(each)))) {
        return 'categories must be at most 8 freedesktop category names (Network, Utility, …)';
    }
    if (icons !== undefined) {
        if (typeof icons !== 'object' || icons === null || Array.isArray(icons)) return 'icons must be an object: { svg, png, icns, ico }';
        for (const [format, member] of Object.entries(icons)) {
            if (!FORMATS.includes(format as IconFormat)) return `icons.${format}: not a format (svg, png, icns, ico)`;
            if (typeof member !== 'string' || !member || member.startsWith('/') || member.split('/').includes('..')) return `icons.${format} must be the path of a file in the archive`;
        }
    }
    return undefined;
}

/**
 * The declared icons, read out of the archive: each a file of at most
 * `MAX_ICON` bytes that starts the way its format does. One that is missing
 * or is not what it says is left out, with a note saying so.
 */
export function readIcons(bytes: Buffer, app: AppDeclaration): { icons: Partial<Record<IconFormat, Buffer>>; notes: string[] } {
    const icons: Partial<Record<IconFormat, Buffer>> = {};
    const notes: string[] = [];
    const zip = new ZLIB.ZipBuffer(bytes);
    for (const [format, member] of Object.entries(app.icons) as [IconFormat, string][]) {
        if (!zip.has(member)) { notes.push(`icons.${format}: the archive has no ${member}`); continue; }
        const entry = zip.get(member);
        if (!entry.isFile || entry.size > MAX_ICON) { notes.push(`icons.${format}: ${member} is not a file of at most ${MAX_ICON / 1024 / 1024} MiB`); continue; }
        const data = entry.contentSync();
        if (!looksLike(format, data)) { notes.push(`icons.${format}: ${member} is not ${KIND[format]} file`); continue; }
        icons[format] = data;
    }
    return { icons, notes };
}

/**
 * What `bundle create` says about an app's declaration, from the files it is
 * about to pack: the declaration, which icon formats it will have, and
 * everything that will keep an install from making the entry it asks for.
 */
export function checkSource(base: string, files: readonly string[]): { app?: AppDeclaration | undefined; formats: IconFormat[]; problems: string[] } {
    let pkg: unknown;
    try {
        pkg = JSON.parse(FS.readFileSync(PATH.join(base, 'package.json'), 'utf-8'));
    } catch {
        return { formats: [], problems: [] };
    }
    const app = (pkg as { bundle?: { app?: unknown } } | null)?.bundle?.app;
    if (app === undefined) return { formats: [], problems: [] };
    const problem = declarationProblem(app);
    if (problem) return { formats: [], problems: [`package.json bundle.app: ${problem}`] };
    const declared = app as AppDeclaration;
    const formats: IconFormat[] = [];
    const problems: string[] = [];
    for (const [format, member] of Object.entries(declared.icons ?? {}) as [IconFormat, string][]) {
        if (!files.includes(member)) { problems.push(`icons.${format}: ${member} is not in the file list`); continue; }
        let data: Buffer;
        try {
            data = FS.readFileSync(PATH.join(base, member));
        } catch {
            problems.push(`icons.${format}: cannot read ${member}`);
            continue;
        }
        if (data.length > MAX_ICON) problems.push(`icons.${format}: ${member} is larger than ${MAX_ICON / 1024 / 1024} MiB`);
        else if (!looksLike(format, data)) problems.push(`icons.${format}: ${member} is not ${KIND[format]} file`);
        else formats.push(format);
    }
    const missing = [!formats.includes('svg') && !formats.includes('png') && 'Linux (svg or png)', !formats.includes('icns') && 'macOS (icns)', !formats.includes('ico') && 'Windows (ico)'].filter(Boolean);
    if (formats.length && missing.length) problems.push(`no icon for ${missing.join(', ')}: the entry there has none`);
    return { app: { ...declared, title: declared.title.trim() }, formats, problems };
}

function looksLike(format: IconFormat, data: Buffer): boolean {
    switch (format) {
        case 'png': return data.length > 24 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        case 'icns': return data.length > 8 && data.toString('latin1', 0, 4) === 'icns' && data.readUInt32BE(4) === data.length;
        case 'ico': return data.length > 6 && data.readUInt16LE(0) === 0 && data.readUInt16LE(2) === 1 && data.readUInt16LE(4) > 0;
        case 'svg': return /<svg[\s>]/.test(data.toString('utf-8', 0, Math.min(data.length, 4096)));
    }
}

// ------------------------------------------------------------------ plans ---

/** Where an entry goes: the platform and its user's directories. Injected by tests. */
export interface Places {
    platform: NodeJS.Platform;
    home: string;
    /** `$XDG_DATA_HOME`, or `~/.local/share`. */
    dataHome: string;
    /** `%APPDATA%` and `%LOCALAPPDATA%`, on Windows. */
    appData: string;
    localAppData: string;
}

export function currentPlaces(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = OS.homedir()): Places {
    const configured = env['XDG_DATA_HOME'];
    return {
        platform,
        home,
        dataHome: configured && PATH.isAbsolute(configured) ? configured : PATH.join(home, '.local', 'share'),
        appData: env['APPDATA'] || PATH.join(home, 'AppData', 'Roaming'),
        localAppData: env['LOCALAPPDATA'] || PATH.join(home, 'AppData', 'Local'),
    };
}

/** What making an entry writes and runs, and what taking it away removes. */
export interface Plan {
    kind: string;
    /** Where a person finds it: the entry itself. */
    entry: string;
    files: { path: string; content: Buffer; mode?: number | undefined }[];
    /** Run in order once the files are written; a failure is a note, not a failed install. */
    commands: string[][];
    /** Removed, in order, when it is taken away — files and the directories that hold only them. */
    remove: string[];
}

export interface PlanInput {
    /** The name it is installed as: what identifies it. */
    name: string;
    app: AppDeclaration;
    icons: Partial<Record<IconFormat, Buffer>>;
    /** The installed archive, which the entry runs. */
    archive: string;
    /** On Windows, the node that runs it — what the .nzip association names. */
    node?: string | undefined;
    places: Places;
}

/** The plan for this platform, or undefined on one that has no menu bundle knows how to add to. */
export function planFor(input: PlanInput): Plan | undefined {
    switch (input.places.platform) {
        case 'darwin': return macPlan(input);
        case 'win32': return windowsPlan(input);
        case 'linux': case 'freebsd': case 'openbsd': case 'netbsd': return freedesktopPlan(input);
        default: return undefined;
    }
}

/** The name, as it is safe in a file name on every system: what an entry's files are called after. */
export function idOf(name: string): string {
    return name.replace(/\.nzip$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'app';
}

/**
 * The title, as a file name a person sees — the `.app` in Applications, the
 * shortcut in Start: no separators or characters Windows refuses, no leading
 * or trailing dots or spaces, and none of the names Windows reserves.
 */
export function fileTitle(title: string): string {
    const cleaned = title.replace(/[<>:"/\\|?*]/g, '-').replace(/^[.\s]+|[.\s]+$/g, '') || 'App';
    return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned) ? `${cleaned} App` : cleaned;
}

// ---- Linux and the other freedesktop systems -------------------------------------------------

function freedesktopPlan({ name, app, icons, archive, places }: PlanInput): Plan {
    const id = idOf(name);
    const entry = PATH.posix.join(places.dataHome, 'applications', `bundle-${id}.desktop`);
    const icon = icons.svg ? { format: 'svg', data: icons.svg } : icons.png ? { format: 'png', data: icons.png } : undefined;
    const iconFile = icon && PATH.posix.join(places.dataHome, 'bundle', 'icons', `${id}.${icon.format}`);
    const lines = [
        '[Desktop Entry]',
        `# Written by 'bundle install' for ${desktopString(name)}; 'bundle uninstall ${desktopString(name)}' removes it.`,
        'Type=Application',
        'Version=1.5',
        `Name=${desktopString(app.title)}`,
        ...(app.description ? [`Comment=${desktopString(app.description)}`] : []),
        `Exec=${[archive, ...app.args].map(execArg).join(' ')}`,
        ...(iconFile ? [`Icon=${desktopString(iconFile)}`] : []),
        'Terminal=false',
        ...(app.categories.length ? [`Categories=${app.categories.join(';')};`] : []),
        'StartupNotify=true',
        `X-Bundle-Name=${desktopString(name)}`,
        '',
    ];
    return {
        kind: 'desktop entry',
        entry,
        files: [
            { path: entry, content: Buffer.from(lines.join('\n')), mode: 0o644 },
            ...(iconFile && icon ? [{ path: iconFile, content: icon.data, mode: 0o644 }] : []),
        ],
        commands: [],
        remove: [entry, ...(iconFile ? [iconFile] : [])],
    };
}

/** A value of the desktop entry spec's `string` type: one line, with its backslashes escaped. */
export function desktopString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
}

/**
 * One argument of an `Exec=` line: always in double quotes, with `"`, `` ` ``,
 * `$` and `\` escaped inside them as the spec says — and then, because the
 * line is itself a `string` value, every backslash escaped again — and `%`
 * doubled, so no field code is read into it.
 */
export function execArg(arg: string): string {
    const quoted = `"${arg.replace(/["`$\\]/g, (c) => `\\${c}`)}"`;
    return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%');
}

// ---- macOS: an application bundle in ~/Applications -------------------------------------------

/** The bundle identifier prefix of the apps bundle writes, by which it knows its own. */
export const MAC_ID_PREFIX = 'com.pipobscure.bundle.app.';

function macPlan({ name, app, icons, archive, places }: PlanInput): Plan {
    const id = idOf(name);
    const bundle = PATH.posix.join(places.home, 'Applications', `${fileTitle(app.title)}.app`);
    const contents = PATH.posix.join(bundle, 'Contents');
    const executable = PATH.posix.join(contents, 'MacOS', id);
    const string = (value: string) => `<string>${xmlEscape(value)}</string>`;
    const plist = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        `<!-- Written by 'bundle install' for ${xmlEscape(name)}; 'bundle uninstall ${xmlEscape(name)}' removes it. -->`,
        '<plist version="1.0">',
        '<dict>',
        `    <key>CFBundleIdentifier</key>${string(`${MAC_ID_PREFIX}${id}`)}`,
        `    <key>CFBundleName</key>${string(app.title)}`,
        `    <key>CFBundleDisplayName</key>${string(app.title)}`,
        `    <key>CFBundleExecutable</key>${string(id)}`,
        ...(icons.icns ? [`    <key>CFBundleIconFile</key>${string('AppIcon.icns')}`] : []),
        ...(app.description ? [`    <key>CFBundleGetInfoString</key>${string(app.description)}`] : []),
        `    <key>CFBundleInfoDictionaryVersion</key>${string('6.0')}`,
        `    <key>CFBundlePackageType</key>${string('APPL')}`,
        `    <key>CFBundleShortVersionString</key>${string('1.0')}`,
        `    <key>CFBundleVersion</key>${string('1')}`,
        // What runs is a script that becomes node, which never checks in with
        // the Dock: shown there, its icon would bounce for as long as the app
        // runs. The window it opens has its own.
        '    <key>LSUIElement</key><true/>',
        '</dict>',
        '</plist>',
        '',
    ].join('\n');
    const script = [
        '#!/bin/sh',
        `# Written by 'bundle install'; runs the installed ${name.replace(/[^\w.@/+-]/g, '?')}.`,
        // Started from Finder, the PATH is the system's alone; Homebrew keeps node elsewhere.
        `PATH="${'/opt/homebrew/bin:/usr/local/bin'}:$PATH" exec ${[archive, ...app.args].map(shQuote).join(' ')} "$@"`,
        '',
    ].join('\n');
    return {
        kind: 'application',
        entry: bundle,
        files: [
            { path: PATH.posix.join(contents, 'Info.plist'), content: Buffer.from(plist), mode: 0o644 },
            { path: executable, content: Buffer.from(script), mode: 0o755 },
            ...(icons.icns ? [{ path: PATH.posix.join(contents, 'Resources', 'AppIcon.icns'), content: icons.icns, mode: 0o644 }] : []),
        ],
        commands: [[LSREGISTER, '-f', bundle]],
        remove: [bundle],
    };
}

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/** A word for `/bin/sh`: in single quotes, each `'` closed, escaped and reopened. */
export function shQuote(word: string): string {
    return `'${word.replace(/'/g, `'\\''`)}'`;
}

function xmlEscape(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- Windows: a Start menu shortcut -------------------------------------------------------------

function windowsPlan({ name, app, icons, archive, node, places }: PlanInput): Plan | undefined {
    if (!node) return undefined;
    const id = idOf(name);
    const dir = PATH.win32.join(places.localAppData, 'bundle', 'apps');
    const script = PATH.win32.join(dir, `${id}.ps1`);
    const icon = icons.ico ? PATH.win32.join(places.localAppData, 'bundle', 'icons', `${id}.ico`) : undefined;
    const shortcut = PATH.win32.join(places.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${fileTitle(app.title)}.lnk`);
    const content = [
        `# Written by 'bundle install' for ${name.replace(/[^\w.@+-]/g, '?')}; 'bundle uninstall' removes it.`,
        '# Started by its Start menu shortcut, hidden: runs the installed archive with',
        '# the node the .nzip association names, and passes on any arguments.',
        `& ${[node, '--no-warnings', '--experimental-vfs', `--vfs-load=${archive}`, '--', ...app.args].map(psQuote).join(' ')} @args`,
        '',
    ].join('\r\n');
    const powershellArgs = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`;
    const make = [
        `$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(shortcut)})`,
        `$shortcut.TargetPath = 'powershell.exe'`,
        `$shortcut.Arguments = ${psQuote(powershellArgs)}`,
        // 7: minimised, so even the moment before -WindowStyle Hidden applies shows nothing.
        `$shortcut.WindowStyle = 7`,
        ...(app.description ? [`$shortcut.Description = ${psQuote(app.description)}`] : []),
        ...(icon ? [`$shortcut.IconLocation = ${psQuote(`${icon},0`)}`] : []),
        `$shortcut.Save()`,
    ].join('; ');
    return {
        kind: 'Start menu shortcut',
        entry: shortcut,
        files: [
            { path: script, content: Buffer.from(content) },
            ...(icon && icons.ico ? [{ path: icon, content: icons.ico }] : []),
        ],
        commands: [['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', make]],
        remove: [shortcut, script, ...(icon ? [icon] : [])],
    };
}

/** PowerShell's single-quoted string: nothing inside is interpreted, and ' doubles. */
export function psQuote(text: string): string {
    return `'${text.replace(/'/g, "''")}'`;
}

// ----------------------------------------------------------- carrying out ---

/** How a plan's commands run — injected by tests, which have none of them. */
export type Runner = (command: string, args: string[]) => { status: number | null; error?: Error | undefined; stderr?: string | undefined };

/**
 * Whether `path`, already there, is bundle's to replace: one this install
 * made before (`ours`), or — for an entry whose files say whose they are — one
 * bundle wrote for this name.
 */
function replaceable(plan: Plan, ours: readonly string[], name: string): boolean {
    if (!FS.existsSync(plan.entry) || ours.includes(plan.entry)) return true;
    try {
        if (plan.kind === 'application') {
            const plist = FS.readFileSync(PATH.join(plan.entry, 'Contents', 'Info.plist'), 'utf-8');
            return plist.includes(`<string>${MAC_ID_PREFIX}${idOf(name)}</string>`);
        }
        if (plan.kind === 'desktop entry') return FS.readFileSync(plan.entry, 'utf-8').includes(`\nX-Bundle-Name=${desktopString(name)}\n`);
    } catch {
        // unreadable: not known to be bundle's
    }
    return false;
}

export interface Made {
    /** What was made, to remember with the install — and remove with it. */
    paths: string[];
    /** Where a person finds it, when there is one. */
    entry?: string | undefined;
    notes: string[];
}

/**
 * Carry `plan` out: unless something not bundle's is where its entry goes,
 * write its files and run its commands. `ours` is what this install made
 * before, which it may replace; anything of that the new plan does not make
 * — a renamed title's old entry — is taken away.
 */
export function make(plan: Plan, { ours = [], name, runner, places = currentPlaces() }: {
    ours?: readonly string[] | undefined;
    name: string;
    runner: Runner;
    places?: Places | undefined;
}): Made {
    if (!replaceable(plan, ours, name)) {
        return { paths: [], notes: [`there is already ${plan.entry}, which bundle did not make; no ${plan.kind} for ${name}`] };
    }
    if (plan.kind === 'application') FS.rmSync(plan.entry, { recursive: true, force: true });
    for (const file of plan.files) {
        FS.mkdirSync(PATH.dirname(file.path), { recursive: true });
        const temporary = `${file.path}.incoming-${process.pid}`;
        FS.writeFileSync(temporary, file.content, { mode: file.mode ?? 0o644 });
        if (file.mode !== undefined && process.platform !== 'win32') FS.chmodSync(temporary, file.mode);
        FS.renameSync(temporary, file.path);
    }
    const notes: string[] = [];
    for (const [command, ...args] of plan.commands) {
        const res = runner(command!, args);
        if (res.error || res.status !== 0) notes.push(`${PATH.basename(command!)} did not finish making the ${plan.kind} (${failure(res)})`);
    }
    takeAway(ours.filter((path) => !plan.remove.includes(path)), places);
    return { paths: plan.remove, entry: plan.entry, notes };
}

/**
 * Remove what an entry made. Only ever paths inside the directories entries
 * are made in — whatever a record says — so a record edited by hand cannot
 * make this delete anything else.
 */
export function takeAway(paths: readonly string[], places: Places = currentPlaces()): string[] {
    const roots = [
        PATH.join(places.dataHome, 'applications'),
        PATH.join(places.dataHome, 'bundle', 'icons'),
        PATH.join(places.home, 'Applications'),
        PATH.join(places.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
        PATH.join(places.localAppData, 'bundle', 'apps'),
        PATH.join(places.localAppData, 'bundle', 'icons'),
    ];
    const removed: string[] = [];
    for (const path of paths) {
        const resolved = PATH.resolve(path);
        if (!roots.some((root) => resolved.startsWith(PATH.resolve(root) + PATH.sep))) continue;
        if (!FS.existsSync(resolved)) continue;
        FS.rmSync(resolved, { recursive: true, force: true });
        removed.push(resolved);
    }
    return removed;
}

function failure(res: ReturnType<Runner>): string {
    if ((res.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return 'it is not installed here';
    if (res.error) return res.error.message;
    return (res.stderr ?? '').trim().split('\n')[0] || `exit ${res.status}`;
}
