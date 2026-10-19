import type { VerificationState } from './manifest.ts';

// How output looks to a person, when there is one.
//
// Everything the CLI prints has two readers. A script reads it through a pipe
// and wants the plain, line-oriented text the docs describe — stable, greppable,
// the same on every machine. A person reads it on a terminal and is better
// served by a little shape: names in bold, details dimmed, states in colour,
// and three marks that always mean the same thing —
//
//   🌳  a bundle, or an app installed from one
//   🔐  a signature over a bundle
//   ✍️  an attestation: someone vouching for a bundle, or warning against it
//
// Which reader there is is decided per stream, since `bundle installed | less`
// has a person on stderr and a pipe on stdout. A `Style` for a pipe changes
// nothing: every function below returns exactly the plain text, so the plain
// output is what it always was, and a style is something added on top of it,
// never something the plain text depends on.

/** The marks, as a person sees them. */
export const MARKS = {
    bundle: '🌳',
    signature: '🔐',
    attestation: '✍️',
} as const;

export type Mark = keyof typeof MARKS;

export interface Style {
    /** Is anyone looking? False is a pipe, a file, or a test: plain text, exactly. */
    readonly people: boolean;

    /** `text` marked as being about a bundle, a signature or an attestation. */
    bundle(text: string): string;
    signature(text: string): string;
    attestation(text: string): string;
    mark(mark: Mark | undefined, text: string): string;

    bold(text: string): string;
    dim(text: string): string;
    green(text: string): string;
    yellow(text: string): string;
    red(text: string): string;
    cyan(text: string): string;

    /** A step, or a fact on the way: `* text` plainly, the mark or a `›` for people. */
    note(text: string, mark?: Mark | undefined): string;
    /** Something worth a second look: `! text`. */
    warn(text: string): string;
    /** The command failed: `error: text`. */
    error(text: string): string;
    /** A verification state, as `STATES` labels it, in the colour it deserves. */
    state(state: VerificationState, label: string): string;
    /**
     * A line some other module wrote for the log — `* fetching …`, `! …`,
     * `  identity: …` — with its leading marker made into the one people see.
     * The words are left alone: they are the other module's.
     */
    line(text: string): string;
}

const identity = (text: string) => text;

/** The style of a pipe: plain text, byte for byte. */
export const PLAIN: Style = {
    people: false,
    bundle: identity, signature: identity, attestation: identity,
    mark: (_mark, text) => text,
    bold: identity, dim: identity, green: identity, yellow: identity, red: identity, cyan: identity,
    note: (text) => `* ${text}`,
    warn: (text) => `! ${text}`,
    error: (text) => `error: ${text}`,
    state: (_state, label) => label,
    line: identity,
};

/** What decides a stream's style: whether it is a terminal, and what that terminal can show. */
export interface Terminal {
    isTTY?: boolean | undefined;
    hasColors?: ((env?: NodeJS.ProcessEnv) => boolean) | undefined;
}

/**
 * The style for one stream. A terminal gets people's formatting; anything
 * else gets `PLAIN`. Colour follows the terminal's own answer, which is where
 * `NO_COLOR`, `FORCE_COLOR` and `TERM=dumb` are honoured. Emoji follow the
 * terminal too: a Windows console that predates Windows Terminal draws them as
 * boxes, so there the marks are left out unless something says it is newer.
 */
export function styleFor(stream: Terminal, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Style {
    if (!stream.isTTY || env['TERM'] === 'dumb') return PLAIN;
    const color = Boolean(stream.hasColors?.(env));
    const emoji = platform !== 'win32' || Boolean(env['WT_SESSION'] || env['TERM_PROGRAM']);
    return fancy({ color, emoji });
}

/** People's formatting — exported so tests, and anyone embedding the CLI, can ask for it. */
export function fancy({ color = true, emoji = true }: { color?: boolean; emoji?: boolean } = {}): Style {
    const sgr = (open: number, close: number) => (color ? (text: string) => `\x1b[${open}m${text}\x1b[${close}m` : identity);
    const bold = sgr(1, 22);
    const dim = sgr(2, 22);
    const green = sgr(32, 39);
    const yellow = sgr(33, 39);
    const red = sgr(31, 39);
    const cyan = sgr(36, 39);
    const mark = (which: Mark | undefined, text: string) => (which && emoji ? `${MARKS[which]} ${text}` : text);

    const style: Style = {
        people: true,
        bundle: (text) => mark('bundle', text),
        signature: (text) => mark('signature', text),
        attestation: (text) => mark('attestation', text),
        mark,
        bold, dim, green, yellow, red, cyan,
        // Without emoji a marked note still needs something in the margin, or
        // it would line up with the indented details under it.
        note: (text, which) => (which && emoji ? mark(which, text) : `${cyan('›')} ${text}`),
        warn: (text) => yellow(`⚠ ${text}`),
        error: (text) => `${red(bold('✖ error:'))} ${text}`,
        state: (state, label) => (state === 'valid' ? green(`✔ ${label}`)
            : state === 'invalid' ? red(`✖ ${label}`)
            : yellow(`⚠ ${label}`)),
        line: (text) => {
            const indent = /^\s*/.exec(text)![0];
            const rest = text.slice(indent.length);
            if (rest.startsWith('* ')) return `${indent}${style.note(rest.slice(2))}`;
            if (rest.startsWith('! ')) return `${indent}${style.warn(rest.slice(2))}`;
            if (rest.startsWith('error: ')) return `${indent}${style.error(rest.slice(7))}`;
            if (rest.startsWith('+ ')) return `${indent}${green('+')} ${rest.slice(2)}`;
            if (rest.startsWith('= ')) return `${indent}${dim(rest)}`;
            return text;
        },
    };
    return style;
}

/** A size as a person reads it: `4.2 MB`. */
export function bytes(size: number): string {
    if (size < 1024) return `${size} B`;
    const units = ['kB', 'MB', 'GB', 'TB'];
    let value = size / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** `count` things, with the noun agreeing: `1 member`, `3 members`. */
export function plural(count: number, noun: string, many = `${noun}s`): string {
    return `${count} ${count === 1 ? noun : many}`;
}

/**
 * Text someone else wrote, made safe to print on one line: control
 * characters (escape sequences that could rewrite the terminal, line breaks
 * that could pass for output of this tool's own) and the marks that reorder
 * text right to left are dropped, and runs of whitespace become one space.
 * An attestation's note is anyone's words, and is shown as such.
 */
export function untrusted(text: string): string {
    return text
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
