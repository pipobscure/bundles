// `nzip:` links: what an author puts on a page so that one click installs
// their app, suite or plugin, with bundle making every decision it would make
// for `bundle install` — in a window, for someone who never sees a terminal.
//
//   nzip:alice.example/devtools              a listing or suite, by handle
//   nzip:did:plc:abc…/devtools               …or by DID
//   nzip:at://did:plc:abc…/<collection>/<name>    …or by its address
//   nzip:alice.example/bled-gpio?for=bled    a plugin, and the app it goes in
//
// A link names something published under a name, and nothing else: not a URL
// and not a domain, so a page cannot point bundle at an arbitrary download
// with it — only at a name whose publisher anyone can look up. What the name
// leads to is fetched and verified, and decided on, exactly as `bundle
// install @alice.example/devtools` would; a link carries no trust of its own,
// and any page can make one, so it is read strictly and asks for nothing.
//
// The one thing a link may add is `?for=`: what `bundle install --for` would
// be given, and only the forms it takes that a page can know — an app's
// listing, or a package name. A plugin's listing already says which app it
// is for, so a link to one needs no `for`; when it has one, the two must
// agree, as they must for --for. It cannot widen what the install may do: the
// plugin is reviewed as any other, and the review says where it goes.
//
// (A domain's `nzip:<url>` TXT record is another thing that starts with
// `nzip:` — it says where to fetch from, and is only ever read from DNS.)

/** The scheme an install link uses: the file type's own name. */
export const SCHEME = 'nzip';

const HANDLE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const DID = /^did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.-]+(?:%3a\d+)?)$/;
const RKEY = /^[A-Za-z0-9._:~-]{1,512}$/;
const NSID = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+\.[a-zA-Z][a-zA-Z0-9]*$/;
// What `for` may be: a package name (as scopes.ts has it, kept here so this
// file needs nothing), `@<handle or did>/<listing name>`, or a listing's address.
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const LISTED = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LISTING = 'com.pipobscure.bundle.listing';

/** What a link asks `bundle install` for: its target, and the app a plugin goes in, when the link says. */
export interface Link {
    /** `@<handle or did>/<name>` or an `at://` address. */
    target: string;
    /** What `--for` would be given: an app's listing, or a package name. */
    for?: string | undefined;
}

/**
 * What `bundle install` is given for the link `link`. Throws, saying why, for
 * anything that is not exactly one of the forms above.
 */
export function readLink(link: string): Link {
    const scheme = `${SCHEME}:`;
    if (link.slice(0, scheme.length).toLowerCase() !== scheme) throw new Error(`'${link}' is not an ${scheme} link`);
    let rest = link.slice(scheme.length);
    if (rest.includes('#')) throw new Error(`${scheme} link '${link}': a link names what to install, and takes nothing after it but ?for=<app>`);
    // `?for=<app>`, once, and nothing else: no other parameter, none twice, none empty.
    const query = rest.indexOf('?');
    let scope: string | undefined;
    if (query >= 0) {
        const match = /^for=([^&=?]+)$/.exec(rest.slice(query + 1));
        if (!match) throw new Error(`${scheme} link '${link}': a link names what to install, and takes nothing after it but ?for=<app>`);
        scope = decoded(match[1]!, link);
        if (!(PACKAGE.test(scope) && scope.length <= 214) && !listed(scope)) {
            throw new Error(`${scheme} link '${link}': for= is an app's listing (@<handle or did>/<name>, or its at:// address) or a package name`);
        }
        rest = rest.slice(0, query);
    }
    // Browsers and desktops may percent-encode a link on its way here; it is decoded once, then checked.
    rest = decoded(rest, link);
    if (/[?#]/.test(rest)) throw new Error(`${scheme} link '${link}': a link names what to install, and takes nothing after it but ?for=<app>`);
    return scope === undefined ? { target: targetIn(rest, link) } : { target: targetIn(rest, link), for: scope };
}

function decoded(text: string, link: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        throw new Error(`${SCHEME}: link '${link}' is not encoded properly`);
    }
}

// The listing or suite a link names.
function targetIn(rest: string, link: string): string {
    const scheme = `${SCHEME}:`;
    if (rest.startsWith('at://')) {
        const parts = rest.slice('at://'.length).split('/');
        if (parts.length !== 3 || !DID.test(parts[0]!) || !NSID.test(parts[1]!) || !RKEY.test(parts[2]!)) {
            throw new Error(`${scheme} link '${link}': an at:// address is at://<did>/<collection>/<name>`);
        }
        return rest;
    }
    // `nzip://alice.example/devtools` is what some pages will write; it means the same.
    rest = rest.replace(/^\/\//, '');
    const slash = rest.indexOf('/');
    const who = slash < 0 ? rest : rest.slice(0, slash).toLowerCase();
    const name = slash < 0 ? '' : rest.slice(slash + 1);
    if (!(HANDLE.test(who) || DID.test(who)) || !RKEY.test(name)) {
        throw new Error(`${scheme} link '${link}': it is ${scheme}<handle or did>/<name> — say, ${scheme}alice.example/devtools`);
    }
    return `@${who}/${name}`;
}

// An app's listing, as --for takes it: `@<handle or did>/<name>`, or its address.
function listed(value: string): boolean {
    const at = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(value);
    if (at) return DID.test(at[1]!) && at[2] === LISTING && LISTED.test(at[3]!);
    const named = /^@([^/]+)\/([^/]+)$/.exec(value);
    return named !== null && (HANDLE.test(named[1]!) || DID.test(named[1]!)) && LISTED.test(named[2]!);
}

/** The link for a target `bundle install` takes: what `bundle publish` and `suite publish` can tell an author to put on a page. */
export function linkFor(target: string): string {
    if (target.startsWith('at://')) return `${SCHEME}:${target}`;
    return `${SCHEME}:${target.replace(/^@/, '')}`;
}

// ------------------------------------------------------------ the handler ---
//
// What makes a click on a link reach bundle: registered for the current user
// when bundle installs itself, beside the .nzip file type, and taken away
// when it is uninstalled. Each runs the installed bundle as
//
//   bundle install --window -- <the link>
//
// with the link one argument, never part of a command line anything parses:
// a desktop entry's %u; an AppleScript's `quoted form of`; a PowerShell
// script's $args, after `-File`. And `--` before it, so not even a link that
// looked like an option could be read as one — though readLink() refuses
// those before anything else happens.

/** The PATH a script started from the macOS desktop gets, before its own: where Homebrew keeps node. */
export const MAC_PATH = '/opt/homebrew/bin:/usr/local/bin';

/** The desktop entry that hands `nzip:` links to `archive`, on Linux and the other freedesktop systems. */
export function desktopHandler(archive: string): string {
    const arg = (value: string) => `"${value.replace(/["`$\\]/g, (c) => `\\${c}`)}"`.replace(/\\/g, '\\\\').replace(/%/g, '%%');
    return [
        '[Desktop Entry]',
        "# Written by 'bundle install'; 'bundle uninstall' removes it. Opens nzip: links.",
        'Type=Application',
        'Version=1.5',
        'Name=bundle',
        'Comment=Install apps from nzip: links',
        `Exec=${arg(archive)} install --window -- %u`,
        'Icon=application-x-nzip',
        'Terminal=false',
        'NoDisplay=true',
        `MimeType=x-scheme-handler/${SCHEME};`,
        '',
    ].join('\n');
}

/**
 * The AppleScript of the applet that receives `nzip:` links on macOS — which
 * arrive as an Apple Event, not as an argument, so a script cannot take them
 * itself. It hands each to `archive` in the background and is done.
 */
export function appleScriptHandler(archive: string): string {
    const literal = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    return [
        "-- Written by 'bundle install'; 'bundle uninstall' removes it. Opens nzip: links.",
        'on open location theURL',
        `\tdo shell script "PATH=${MAC_PATH}:$PATH " & quoted form of ${literal(archive)} & " install --window -- " & quoted form of theURL & " > /dev/null 2>&1 &"`,
        'end open location',
        'on run',
        '\tdisplay dialog "This is how bundle opens nzip: links, which install apps. There is nothing to do here." buttons {"OK"} default button 1 with title "bundle"',
        'end run',
        '',
    ].join('\n');
}

/** The PowerShell script the `nzip:` URL protocol runs on Windows, hidden: node, with `archive` mounted. */
export function windowsHandlerScript(node: string, archive: string): string {
    const q = (text: string) => `'${text.replace(/'/g, "''")}'`;
    return [
        "# Written by 'bundle install'; 'bundle uninstall' removes it. Opens nzip: links.",
        '# Started hidden by the nzip URL protocol, with the link as its one argument.',
        'if ($args.Count -ne 1) { exit 64 }',
        `& ${[node, '--no-warnings', '--experimental-vfs', `--vfs-load=${archive}`, '--', 'install', '--window', '--'].map(q).join(' ')} $args[0]`,
        '',
    ].join('\r\n');
}

/** The command the `nzip:` URL protocol is registered with: that script, hidden, given the link. */
export function windowsHandlerCommand(script: string): string {
    return `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}" "%1"`;
}
