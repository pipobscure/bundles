#!/usr/bin/env node
import * as FS from 'node:fs';
import * as OS from 'node:os';
import * as PATH from 'node:path';
import { spawnSync } from 'node:child_process';
import { moduleFiles, packageRoot } from '../src/files.ts';
import { ensureTestPki } from './testpki.ts';

// Step 1 of building a bundle: work out what goes in it.
//
// The output is `build/cli.manifest`, a newline-separated file list that
// `bundle create --files` consumes directly — the same artifact the recording
// provider produces for anyone else's application, so this step is not special
// pleading for the tool's own build.
//
// Two passes, because neither is sufficient alone.
//
//   1. A computed closure — every compiled module, the skills, and the full
//      dependency tree of the runtime dependencies. Complete by construction,
//      including code that only a path never taken in a test run would reach.
//
//   2. An observation run — the CLI driven through a recording mount, doing
//      real work. Its output is not the member list; it is the *check* on the
//      list. Anything read that pass 1 did not include is a hole, and the build
//      stops rather than shipping an archive that fails on someone else's
//      machine.
//
// Pass 2 is also what keeps `record` honest: the recording provider is
// exercised by every build of this package, over the real tree.

const ROOT = packageRoot();
const BUILD = PATH.join(ROOT, 'build');
const OUTPUT = PATH.join(BUILD, 'cli.manifest');

/** Runtime dependencies of the CLI — signing included, so `sign` works inside. */
const RUNTIME = ['@sigstore/bundle', '@sigstore/sign', '@sigstore/verify', '@sigstore/protobuf-specs', '@sigstore/tuf'];

const files = moduleFiles({
    base: ROOT,
    files: ['package.json'],
    dirs: ['dist', 'skills'],
    dependencies: RUNTIME,
    // The bundle is what runs; the maps and declarations beside it are what you
    // read, and `files` in package.json already ships those.
    filter: (name) => !name.endsWith('.map') && !name.endsWith('.d.ts') && !name.endsWith('.d.cts'),
});

const missing = files.filter((name) => !FS.existsSync(PATH.join(ROOT, name)));
if (missing.length) {
    fail(`the computed file list names files that are not there — run 'npm run build' first:\n  ${missing.slice(0, 5).join('\n  ')}`);
}

console.error(`* ${files.length} members from ${RUNTIME.length} runtime dependencies and the compiled package`);

const observed = observe();
const holes = observed.filter((name) => !files.includes(name));
if (holes.length) {
    fail(`the observation run read files the computed list does not contain:\n  ${holes.join('\n  ')}`);
}
console.error(`* observation run read ${observed.length} files, all of them present`);

FS.mkdirSync(BUILD, { recursive: true });
FS.writeFileSync(OUTPUT, `${files.join('\n')}\n`);
console.error(`* wrote ${PATH.relative(ROOT, OUTPUT)}`);
console.error("* next: 'npm run pack:cli' to build the unsigned archive");

// Drive the CLI through a recording mount of the package root, doing enough
// real work to be worth checking against: help, a build, a signature, a
// verification, and a skill install. The manifest lands outside the mount, so
// writing it is not itself a read of the tree being observed.
function observe(): string[] {
    const scratch = FS.mkdtempSync(PATH.join(OS.tmpdir(), 'bundle-observe-'));
    try {
        const entry = PATH.join(ROOT, 'tools', 'observe.ts');
        const list = PATH.join(scratch, 'members.txt');
        FS.writeFileSync(list, 'package.json\n');
        const archive = PATH.join(scratch, 'observed.bundle');
        const signed = PATH.join(scratch, 'observed.signed.bundle');
        // The observation has to take the signing and verifying paths to be worth
        // anything, and that needs a credential; a throwaway one, generated here.
        const pki = ensureTestPki();

        const runs: string[][] = [
            ['help'],
            ['create', '--base', ROOT, '--files', list, '--output', archive],
            ['sign', '--key', pki.key, '--chain', pki.chain, '--output', signed, archive],
            ['verify', '--root', pki.root, '--json', signed],
            ['skill', '--list'],
            ['skill', '--dir', PATH.join(scratch, 'skills')],
        ];

        // One manifest per run and merged afterwards: the recorder truncates on
        // the main thread, so a shared destination would keep only the last.
        const seen = new Set<string>();
        for (const [index, args] of runs.entries()) {
            const manifest = PATH.join(scratch, `read-${index}.manifest`);
            const res = spawnSync(process.execPath, [
                '--no-warnings', '--experimental-vfs', entry, ...args,
            ], {
                encoding: 'utf-8',
                cwd: scratch,
                env: { ...process.env, BUNDLE_MANIFEST: manifest },
            });
            if (res.status !== 0) {
                fail(`the observation run failed on '${args[0]}' (exit ${res.status}):\n${res.stderr}`);
            }
            for (const line of FS.readFileSync(manifest, 'utf-8').split('\n')) {
                if (line) seen.add(line);
            }
        }
        return [...seen].sort();
    } finally {
        FS.rmSync(scratch, { recursive: true, force: true });
    }
}

function fail(reason: string): never {
    console.error(`error: ${reason}`);
    process.exit(1);
}
