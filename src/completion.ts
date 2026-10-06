import * as FS from 'node:fs';
import * as OS from 'node:os';
import * as PATH from 'node:path';
import { COMMANDS, OPTIONS, USAGE } from './cli.ts';

// Tab completion, for bash, zsh and fish.
//
// A shell does not know a program's options; it asks. Each has its own way of
// asking — bash runs a command with the line in COMP_LINE/COMP_POINT and reads
// candidates back one per line (`complete -C`), zsh can do the same through
// `bashcompinit`, and fish calls a function whose output may carry
// descriptions — and every one of them can be pointed at the program itself.
// So `bundle __complete` answers, and `bundle shell <shell>` prints the few
// lines that wire a shell to it — along with a quiet `bundle validate`, so a
// new terminal is also where news about installed bundles arrives.
//
// What it offers comes from the same places the commands do: the commands are
// `COMMANDS`, their options are `OPTIONS` — what `parseArgs` is handed — and
// the descriptions are the usage text's own. Values are offered where there is
// something to offer: installed names for update/uninstall/validate, the two
// verdicts, the sign-in flows, subcommands; files where a file goes, which the
// shell completes itself.

/** One candidate, with what it is for, where the shell can show that. */
export interface Candidate {
    value: string;
    description?: string | undefined;
}

/** What to offer for the word being completed. */
export interface Completion {
    candidates: Candidate[];
    /** Complete file names instead — the shell does that better than we would. */
    files: boolean;
}

type Hint = 'files' | 'installed' | 'skills' | readonly string[];

// What a command's positional arguments are.
const POSITIONALS: Record<string, Hint | ((positionals: string[]) => Hint | null)> = {
    sign: 'files', verify: 'files', audit: 'files', attest: 'files', sea: 'files',
    // Everything after the archive belongs to the program being run.
    run: (positionals) => (positionals.length === 0 ? 'files' : null),
    update: 'installed', uninstall: 'installed', validate: 'installed',
    skill: 'skills',
    policy: (positionals) => (positionals.length === 0 ? ['show', 'init', 'check'] : positionals[0] === 'check' ? 'files' : null),
    lexicon: (positionals) => (positionals.length === 0 ? ['check', 'publish'] : null),
    shell: (positionals) => (positionals.length === 0 ? ['bash', 'zsh', 'fish'] : null),
};

// What an option's value is, where that is something worth offering. Keyed by
// `command.option` first, then by the option's name wherever it appears.
const VALUES: Record<string, Hint> = {
    'attest.verdict': ['good', 'bad'],
    'attest.kind': ['published', 'audited', 'reproduced', 'malware', 'vulnerable', 'abandoned'],
    'audit.verdict': 'files',
    'audit.baseline': 'files',
    'create.base': 'files',
    'policy.app': 'installed',
    root: 'files', output: 'files', files: 'files', key: 'files', chain: 'files', prefix: 'files',
    node: 'files', base: 'files', dir: 'files', archive: 'files', 'password-file': 'files', 'sigstore-root': 'files',
    flow: ['auto', 'ci', 'browser', 'device'],
    connector: ['github', 'google', 'microsoft'],
    hash: ['sha256', 'sha384', 'sha512'],
    sign: ['sha256', 'sha384', 'sha512'],
    issuer: ['https://token.actions.githubusercontent.com', 'https://oauth2.sigstore.dev/auth', 'https://accounts.google.com'],
};

/**
 * What to offer for `current`, the word under the cursor, after `words` — the
 * words before it, not counting the program's own name.
 */
export async function complete(words: string[], current: string): Promise<Completion> {
    const none: Completion = { candidates: [], files: false };
    const filter = (candidates: Candidate[], prefix = ''): Completion => ({
        candidates: candidates.filter(({ value }) => value.startsWith(current.slice(prefix.length))).map((each) => ({ ...each, value: prefix + each.value })),
        files: false,
    });

    // The command itself.
    if (words.length === 0) {
        if (current.startsWith('-')) return filter([{ value: '--help', description: 'show the usage' }, { value: '--version', description: 'print the version' }]);
        return filter(Object.keys(COMMANDS).map((name) => ({ value: name, description: commandDescriptions().get(name) })));
    }
    const command = words[0]!;
    if (command === 'help') return none;
    const options = (OPTIONS as Record<string, Record<string, { type: string; short?: string; default?: unknown }>>)[command];
    if (!options) return none;
    const rest = words.slice(1);

    // `run` stops being `run`'s at the archive: what follows is the program's.
    if (command === 'run' && positionalsOf(rest, options).length > 0) return { candidates: [], files: true };

    // `--option=value`, completed as a whole word.
    const inline = /^(--[A-Za-z0-9-]+=)(.*)$/.exec(current);
    if (inline) {
        const name = inline[1]!.slice(2, -1);
        if (options[name]?.type !== 'string') return none;
        return await values(command, name, inline[1]!, filter);
    }

    // The value of the option just before.
    const previous = rest[rest.length - 1];
    if (previous?.startsWith('-') && !previous.includes('=')) {
        const name = optionName(previous, options);
        if (name && options[name]!.type === 'string') return await values(command, name, '', filter);
    }

    // Options.
    if (current.startsWith('-')) {
        const described = optionDescriptions(command);
        const candidates: Candidate[] = [];
        for (const [name, option] of Object.entries(options)) {
            candidates.push({ value: `--${name}`, description: described.get(name) });
            // A boolean that defaults on is turned off as `--no-<name>`.
            if (option.type === 'boolean' && option.default === true) candidates.push({ value: `--no-${name}`, description: described.get(`no-${name}`) });
        }
        return filter(candidates);
    }

    // Positionals.
    const rule = POSITIONALS[command];
    const hint = typeof rule === 'function' ? rule(positionalsOf(rest, options)) : rule;
    if (!hint) return none;
    return await offer(hint, '', filter);
}

async function values(command: string, name: string, prefix: string,
    filter: (candidates: Candidate[], prefix?: string) => Completion): Promise<Completion> {
    const hint = VALUES[`${command}.${name}`] ?? VALUES[name];
    if (!hint) return { candidates: [], files: false };
    return await offer(hint, prefix, filter);
}

async function offer(hint: Hint, prefix: string, filter: (candidates: Candidate[], prefix?: string) => Completion): Promise<Completion> {
    if (hint === 'files') return { candidates: [], files: true };
    if (hint === 'installed') {
        const { records } = await import('./install.ts');
        return filter(Object.values(records()).map((record) => ({ value: record.name, description: record.url })), prefix);
    }
    if (hint === 'skills') {
        const { skills } = await import('./skill.ts');
        return filter(skills().map((skill) => ({ value: skill.name, description: skill.description })), prefix);
    }
    return filter(hint.map((value) => ({ value })), prefix);
}

// The positionals among `words`: what is left once options, and the values of
// options that take one, are set aside.
function positionalsOf(words: string[], options: Record<string, { type: string; short?: string }>): string[] {
    const found: string[] = [];
    for (let i = 0; i < words.length; i++) {
        const word = words[i]!;
        if (word === '--') return [...found, ...words.slice(i + 1)];
        if (word.startsWith('-') && word !== '-') {
            const name = optionName(word, options);
            if (name && options[name]!.type === 'string' && !word.includes('=')) i++;
            continue;
        }
        found.push(word);
    }
    return found;
}

function optionName(word: string, options: Record<string, { short?: string }>): string | undefined {
    if (word.startsWith('--')) {
        const name = word.slice(2).split('=')[0]!;
        return Object.hasOwn(options, name) ? name : undefined;
    }
    const short = word.slice(1, 2);
    return Object.entries(options).find(([, option]) => option.short === short)?.[0];
}

// ------------------------------------------------------------ descriptions ---

let commands: Map<string, string> | undefined;

/** Each command's one-line description, from the usage text's command list. */
function commandDescriptions(): Map<string, string> {
    if (commands) return commands;
    commands = new Map();
    const lines = USAGE.split('\n');
    for (const line of lines.slice(lines.indexOf('commands:') + 1)) {
        if (!line.trim()) break;
        const m = /^ {2}(\S+)\s+(.*)$/.exec(line);
        if (m) commands.set(m[1]!, m[2]!.trim());
    }
    return commands;
}

/** A command's options' descriptions, from its section of the usage text. */
function optionDescriptions(command: string): Map<string, string> {
    const described = new Map<string, string>();
    const lines = USAGE.split('\n');
    const start = lines.findIndex((line) => line.startsWith(`${command} options:`));
    if (start < 0) return described;
    let last: string | undefined;
    for (const line of lines.slice(start + 1)) {
        if (/^\S/.test(line)) break;
        const m = /^\s+(?:-\w, )?--([A-Za-z0-9-]+)(?: <[^>]+>)?\s{2,}(.*)$/.exec(line);
        if (m) {
            last = m[1]!;
            described.set(last, m[2]!.trim());
        } else if (last && /^\s{20,}\S/.test(line)) {
            // A description that wraps carries on, indented, on the next line.
            described.set(last, `${described.get(last)} ${line.trim()}`);
        } else {
            last = undefined;
        }
    }
    return described;
}

// --------------------------------------------------------- the shell's side ---

/**
 * Answer a shell's request. `argv` is what follows `bundle __complete`:
 *
 *   --shell fish -- <words…> <current>    words as the shell split them
 *   --shell bash  [<program> <current> <previous>]
 *                                         bash's `complete -C`, whose real
 *                                         input is COMP_LINE and COMP_POINT
 */
export async function respond(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
    const shellAt = argv.indexOf('--shell');
    const shell = shellAt >= 0 ? argv[shellAt + 1] : 'bash';
    const dashes = argv.indexOf('--');

    let words: string[];
    let current: string;
    if (dashes >= 0) {
        const given = argv.slice(dashes + 1);
        current = given.length ? given[given.length - 1]! : '';
        words = given.slice(0, -1);
    } else {
        const line = (env['COMP_LINE'] ?? '').slice(0, Number(env['COMP_POINT'] ?? env['COMP_LINE']?.length ?? 0));
        const split = splitLine(line);
        words = split.words.slice(1);
        current = split.current;
    }

    const { candidates, files } = await complete(words, current);
    if (shell === 'fish') {
        if (files) return [':files'];
        return candidates.map(({ value, description }) => (description ? `${value}\t${description}` : value));
    }
    // With nothing printed, bash and zsh fall back to file names
    // (`complete -o default`). zsh's bash emulation replaces the whole word;
    // bash itself replaces only what follows the last word-break character in
    // it — `=` and `:` among them — so that is all bash is handed back.
    if (files) return [];
    if (shell === 'zsh') return candidates.map(({ value }) => value);
    const breaks = env['COMP_WORDBREAKS'] ?? ' \t\n"\'><=;|&(:';
    let cut = -1;
    for (const char of breaks) cut = Math.max(cut, current.lastIndexOf(char));
    return candidates.map(({ value }) => value.slice(cut + 1));
}

/** Split a command line the way a shell would, enough for completion: words, and the one being typed. */
export function splitLine(line: string): { words: string[]; current: string } {
    const words: string[] = [];
    let word = '';
    let quote: string | null = null;
    let started = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i]!;
        if (quote) {
            if (char === quote) quote = null;
            else if (char === '\\' && quote === '"' && i + 1 < line.length) word += line[++i];
            else word += char;
        } else if (char === '"' || char === "'") {
            quote = char;
            started = true;
        } else if (char === '\\' && i + 1 < line.length) {
            word += line[++i];
            started = true;
        } else if (/\s/.test(char)) {
            if (started) words.push(word);
            word = '';
            started = false;
        } else {
            word += char;
            started = true;
        }
    }
    return { words, current: word };
}

/** What `bundle shell` puts in a shell's startup. */
export interface ShellOptions {
    /** Tab completion (default: true). */
    complete?: boolean | undefined;
    /** Re-validate installs in interactive shells (default: true). */
    validate?: boolean | undefined;
    /** How often that asks the network (default: '1d'). */
    every?: string | undefined;
    /** How long it may wait for the network (default: '5s'). */
    timeout?: string | undefined;
}

/**
 * What to load when `shell` starts, meant to be evaluated from its startup
 * file: Tab completion wired to `bundle __complete`, and — interactive shells
 * only — a quiet `bundle validate`, so a new warning about something installed
 * is the first thing a new terminal says.
 */
export function script(shell: string, { complete = true, validate = true, every = '1d', timeout = '5s' }: ShellOptions = {}, program = 'bundle'): string {
    const check = `${program} validate --quiet --every ${every} --timeout ${timeout}`;
    const fn = `__${program.replace(/\W/g, '_')}_complete`;
    const lines = (...parts: (string | false)[]) => `${parts.filter(Boolean).join('\n')}\n`;
    switch (shell) {
        case 'bash':
            return lines(
                `# ${program}, for bash. In ~/.bashrc:  eval "$(${program} shell bash)"`,
                complete && `complete -o default -C '${program} __complete --shell bash' ${program}`,
                validate && `if [[ $- == *i* ]]; then ${check}; fi`,
            );
        case 'zsh':
            return lines(
                `# ${program}, for zsh. In ~/.zshrc:  eval "$(${program} shell zsh)"`,
                // Completion through zsh's bash compatibility; compinit only if
                // nothing has set it up yet, since most configurations do.
                complete && `(( $+functions[compdef] )) || { autoload -Uz compinit && compinit; }`,
                complete && `autoload -U +X bashcompinit && bashcompinit`,
                complete && `complete -o default -C '${program} __complete --shell zsh' ${program}`,
                validate && `if [[ -o interactive ]]; then ${check}; fi`,
            );
        case 'fish':
            return lines(
                `# ${program}, for fish. In ~/.config/fish/config.fish:  ${program} shell fish | source`,
                // fish ships completions for Ruby's Bundler, also called
                // `bundle`; these replace them rather than mix with them.
                complete && `complete -c ${program} -e`,
                complete && `function ${fn}`,
                complete && `    set -l tokens (commandline -opc)`,
                complete && `    set -l current (commandline -ct)`,
                complete && `    set -l out (${program} __complete --shell fish -- $tokens[2..-1] "$current" 2>/dev/null)`,
                complete && `    if test "$out[1]" = ':files'`,
                complete && `        __fish_complete_path "$current"`,
                complete && `    else`,
                complete && `        printf '%s\\n' $out`,
                complete && `    end`,
                complete && `end`,
                complete && `complete -c ${program} -f -a '(${fn})'`,
                validate && `if status is-interactive\n    ${check}\nend`,
            );
        default:
            throw new Error(`shell: no support for '${shell}' — bash, zsh or fish`);
    }
}

/** The shell this is probably being run from, by its `SHELL` (bash when it cannot tell). */
export function currentShell(env: NodeJS.ProcessEnv = process.env): string {
    return detectShell(env) ?? 'bash';
}

// ------------------------------------------------------------ startup files ---

// The block `bundle install` adds to a shell's startup file, between markers,
// so it can be found again: to leave alone when it is there, and to take out
// on uninstall. It loads `bundle shell` only when `bundle` is on the PATH, so
// a shell never fails to start for want of it.
const BEGIN = '# >>> bundle: Tab completion, and a quiet re-check of installs >>>';
const END = '# <<< bundle <<<';

/**
 * The shell `SHELL` names, if it is one this knows how to set up — by what the
 * shell is, not what platform it runs on: Git Bash on Windows names
 * `/usr/bin/bash`, or `C:\\Program Files\\Git\\usr\\bin\\bash.exe`, and is bash.
 */
export function detectShell(env: NodeJS.ProcessEnv = process.env): 'bash' | 'zsh' | 'fish' | null {
    const name = (env['SHELL'] ?? '').split(/[\\/]/).pop()?.replace(/\.exe$/i, '').toLowerCase() ?? '';
    return name === 'bash' || name === 'zsh' || name === 'fish' ? name : null;
}

/** The file an interactive `shell` reads at start. */
export function startupFile(shell: 'bash' | 'zsh' | 'fish', env: NodeJS.ProcessEnv = process.env): string {
    const home = env['HOME'] || OS.homedir();
    if (shell === 'zsh') return PATH.join(env['ZDOTDIR'] || home, '.zshrc');
    if (shell === 'fish') return PATH.join(env['XDG_CONFIG_HOME'] || PATH.join(home, '.config'), 'fish', 'config.fish');
    return PATH.join(home, '.bashrc');
}

/** The one line that loads `bundle shell` — only when `bundle` is there to run. */
export function hookLine(shell: 'bash' | 'zsh' | 'fish', program = 'bundle'): string {
    return shell === 'fish'
        ? `command -q ${program}; and ${program} shell fish | source`
        : `command -v ${program} >/dev/null 2>&1 && eval "$(${program} shell ${shell})"`;
}

/** Whether `file` already carries the block. */
export function hasHook(file: string): boolean {
    try {
        return FS.readFileSync(file, 'utf-8').includes(BEGIN);
    } catch {
        return false;
    }
}

/** Add the block to `shell`'s startup file, unless it is there already. Returns the file. */
export function addHook(shell: 'bash' | 'zsh' | 'fish', env: NodeJS.ProcessEnv = process.env, program = 'bundle'): { file: string; added: boolean } {
    const file = startupFile(shell, env);
    if (hasHook(file)) return { file, added: false };
    let before = '';
    try {
        before = FS.readFileSync(file, 'utf-8');
    } catch {
        // A new file, then.
    }
    FS.mkdirSync(PATH.dirname(file), { recursive: true });
    const gap = !before ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    FS.writeFileSync(file, `${before}${gap}${BEGIN}\n${hookLine(shell, program)}\n${END}\n`);
    return { file, added: true };
}

/** Take the block out of every shell's startup file that carries it. Returns the files changed. */
export function removeHooks(env: NodeJS.ProcessEnv = process.env): string[] {
    const changed: string[] = [];
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
        const file = startupFile(shell, env);
        if (!hasHook(file)) continue;
        const text = FS.readFileSync(file, 'utf-8');
        const start = text.indexOf(BEGIN);
        const end = text.indexOf(END, start);
        if (end < 0) continue; // a block somebody edited apart: leave it to them
        const after = text.slice(end + END.length).replace(/^\n/, '');
        FS.writeFileSync(file, `${text.slice(0, start).replace(/\n\n$/, '\n')}${after}`);
        changed.push(file);
    }
    return changed;
}
