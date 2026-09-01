import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { fileURLToPath } from 'node:url';

// The Claude Code skills this package ships, and installing them into a working
// directory.
//
// A signature answers *who produced these bytes*; it does not answer *are these
// bytes safe*. `audit-bundle` is the second question written down as a
// procedure — verify, extract, review — and it belongs next to whoever is about
// to run an archive rather than in this repository, so the CLI can write it
// out: `bundle skill` drops it into `.claude/skills/` where Claude Code will
// find it.
//
// The skill files are ordinary package members, read from disk relative to this
// module. That holds inside a mounted bundle too, as long as they were recorded
// in the manifest the bundle was built from — which is why the build's
// observation run installs a skill.

/** Where a skill's files live in this package. */
const ROOT = new URL('../skills/', import.meta.url);

/** The conventional place Claude Code looks for project-local skills. */
export const DEFAULT_SKILLS_DIR = PATH.join('.claude', 'skills');

export interface SkillInfo {
    /** Directory name, which is also the name Claude Code invokes it by. */
    name: string;
    /** The `description:` from the skill's front matter, when it has one. */
    description: string;
    /** Absolute path to the skill's directory inside this package. */
    source: string;
    /** File names the skill consists of, relative to its directory. */
    files: string[];
}

export interface InstallResult {
    name: string;
    /** Absolute path of the installed skill's directory. */
    path: string;
    /** Absolute paths of the files written. */
    written: string[];
    /** Absolute paths of files that already existed and were left alone. */
    skipped: string[];
}

/** Every skill this package carries, in name order. */
export function skills(): SkillInfo[] {
    const dir = fileURLToPath(ROOT);
    let names: string[];
    try {
        names = FS.readdirSync(dir).sort();
    } catch {
        return [];
    }
    const found: SkillInfo[] = [];
    for (const name of names) {
        const source = PATH.join(dir, name);
        let files: string[];
        try {
            if (!FS.statSync(source).isDirectory()) continue;
            files = walk(source);
        } catch {
            continue;
        }
        if (!files.includes('SKILL.md')) continue;
        found.push({ name, description: describe(PATH.join(source, 'SKILL.md')), source, files });
    }
    return found;
}

/** One skill by name, or null when this package does not carry it. */
export function skill(name: string): SkillInfo | null {
    return skills().find((entry) => entry.name === name) ?? null;
}

/**
 * Write a skill into `dir` (default `.claude/skills`), as `<dir>/<name>/…`.
 *
 * Existing files are left alone unless `force` is set, so re-running this never
 * silently discards local edits; what was skipped comes back in the result.
 */
export function install(name: string, { dir = DEFAULT_SKILLS_DIR, force = false }: {
    dir?: string | undefined;
    force?: boolean | undefined;
} = {}): InstallResult {
    const found = skill(name);
    if (!found) {
        const known = skills().map((entry) => entry.name);
        throw new Error(`unknown skill: ${name}${known.length ? ` (this package carries: ${known.join(', ')})` : ''}`);
    }

    const target = PATH.resolve(dir, name);
    const written: string[] = [];
    const skipped: string[] = [];
    for (const file of found.files) {
        const to = PATH.join(target, file);
        if (!force && FS.existsSync(to)) {
            skipped.push(to);
            continue;
        }
        FS.mkdirSync(PATH.dirname(to), { recursive: true });
        FS.writeFileSync(to, FS.readFileSync(PATH.join(found.source, file)));
        written.push(to);
    }
    return { name: found.name, path: target, written, skipped };
}

// Every file under `dir`, as `/`-separated paths relative to it.
function walk(dir: string, prefix = ''): string[] {
    const out: string[] = [];
    for (const entry of FS.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...walk(PATH.join(dir, entry.name), relative));
        else if (entry.isFile()) out.push(relative);
    }
    return out;
}

// The `description:` line from a skill's YAML front matter — the one-liner
// Claude Code uses to decide whether a skill is relevant.
function describe(path: string): string {
    try {
        const text = FS.readFileSync(path, 'utf-8');
        const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
        if (!front) return '';
        const line = /^description:[ \t]*(.*)$/m.exec(front[1]!);
        return line ? line[1]!.trim().replace(/^["']|["']$/g, '') : '';
    } catch {
        return '';
    }
}
