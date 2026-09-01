import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as VFS from 'node:vfs';
import { Manifest, recording, register } from '../src/recorder.ts';
import { scratch } from './helpers.ts';

// The recording provider that replaces the `--vfs-manifest` flag. These mount a
// VFS directly rather than going through `--vfs-mount`, because node consults
// registered providers for a mounted *file* and mounts a directory with its own
// `RealFSProvider` without asking — so a directory mount cannot be influenced
// from a preload, and the mount has to be made here.

const FILES: Record<string, string> = {
    'index.js': 'export const main = true;\n',
    'data.txt': 'payload\n',
    'unused.js': 'export const nope = true;\n',
    'sub/nested.txt': 'nested\n',
};

const tmp = scratch('recorder');
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

let counter = 0;
function fixture(): string {
    const dir = PATH.join(tmp, `fixture-${counter++}`);
    for (const [name, content] of Object.entries(FILES)) {
        const file = PATH.join(dir, name);
        FS.mkdirSync(PATH.dirname(file), { recursive: true });
        FS.writeFileSync(file, content);
    }
    return dir;
}

// Mounts `dir` behind a recording RealFSProvider, runs `body` to completion, and
// returns the recorded lines. `body` is awaited before the unmount: a stream
// opens on a later tick, and a VFS that is no longer mounted resolves paths
// against the real filesystem instead.
async function record(dir: string, body: (mount: string) => unknown, options: { truncate?: boolean } = {}) {
    const out = `${dir}.manifest`;
    const manifest = new Manifest(out, { truncate: true, ...options });
    const Recording = recording(VFS.RealFSProvider, manifest);
    const vfs = VFS.create(new Recording(dir), { emitExperimentalWarning: false });
    const mount = vfs.mount();
    try {
        await body(mount);
    } finally {
        vfs.unmount();
    }
    return FS.readFileSync(out, 'utf-8').split('\n').filter(Boolean);
}

test('every file read through the mount is recorded, relative to it', async () => {
    const dir = fixture();
    const lines = await record(dir, (mount) => {
        FS.readFileSync(PATH.join(mount, 'index.js'), 'utf-8');
        FS.readFileSync(PATH.join(mount, 'sub/nested.txt'), 'utf-8');
    });
    assert.deepEqual(lines.sort(), ['index.js', 'sub/nested.txt']);
});

test('a file that is never read is never recorded', async () => {
    const dir = fixture();
    const lines = await record(dir, (mount) => {
        FS.readFileSync(PATH.join(mount, 'index.js'), 'utf-8');
    });
    assert.ok(!lines.includes('unused.js'));
});

test('a file read repeatedly is recorded once', async () => {
    const dir = fixture();
    const lines = await record(dir, (mount) => {
        for (let i = 0; i < 5; i++) FS.readFileSync(PATH.join(mount, 'data.txt'));
    });
    assert.deepEqual(lines, ['data.txt']);
});

test('a streamed read is recorded too', async () => {
    const dir = fixture();
    const lines = await record(dir, (mount) => new Promise<void>((resolve, reject) => {
        FS.createReadStream(PATH.join(mount, 'data.txt'))
            .on('data', () => {})
            .on('error', reject)
            .on('end', () => resolve());
    }));
    assert.deepEqual(lines, ['data.txt']);
});

test('an async read is recorded too', async () => {
    const dir = fixture();
    const lines = await record(dir, async (mount) => {
        await FS.promises.readFile(PATH.join(mount, 'data.txt'));
    });
    assert.deepEqual(lines, ['data.txt']);
});

test('opening a file for writing is not a read', async () => {
    const dir = fixture();
    const lines = await record(dir, (mount) => {
        FS.writeFileSync(PATH.join(mount, 'written.txt'), 'new');
        FS.readFileSync(PATH.join(mount, 'index.js'));
    });
    assert.deepEqual(lines, ['index.js']);
});

test('a manifest starts fresh, or appends when told to', () => {
    const dir = fixture();
    const out = PATH.join(dir, 'list.txt');
    FS.writeFileSync(out, 'stale.js\n');

    new Manifest(out, { truncate: false }).record('/kept.js');
    assert.deepEqual(FS.readFileSync(out, 'utf-8').split('\n').filter(Boolean), ['stale.js', 'kept.js']);

    new Manifest(out, { truncate: true }).record('/fresh.js');
    assert.deepEqual(FS.readFileSync(out, 'utf-8').split('\n').filter(Boolean), ['fresh.js']);
});

test('a manifest reports what it has seen without re-reading the file', () => {
    const dir = fixture();
    const manifest = new Manifest(PATH.join(dir, 'seen.txt'), { truncate: true });
    manifest.record('/a.js');
    manifest.record('/a.js');
    manifest.record('/b.js');
    assert.deepEqual(manifest.paths, ['a.js', 'b.js']);
});

test('recording never breaks the read it is bookkeeping for', () => {
    const dir = fixture();
    // A destination that cannot be written to must not turn a good read into a
    // failure — the file list is a build artefact, not the program's business.
    const manifest = new Manifest(PATH.join(dir, 'sub'), { truncate: false });
    assert.doesNotThrow(() => manifest.record('/index.js'));
});

test('recording is skipped entirely when no destination is configured', () => {
    const previous = process.env['BUNDLE_MANIFEST'];
    delete process.env['BUNDLE_MANIFEST'];
    try {
        assert.equal(register(), null);
    } finally {
        if (previous !== undefined) process.env['BUNDLE_MANIFEST'] = previous;
    }
});

test('the recorded list is what create() consumes', async () => {
    const dir = fixture();
    const lines = await record(dir, (mount) => {
        FS.readFileSync(PATH.join(mount, 'index.js'));
        FS.readFileSync(PATH.join(mount, 'sub/nested.txt'));
    });
    // Every line has to resolve against the mount root as a --base.
    for (const line of lines) assert.ok(FS.existsSync(PATH.join(dir, line)), line);
});
