import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as OS from 'node:os';
import * as PATH from 'node:path';
import * as VFS from 'node:vfs';
import { Manifest, recording, register } from '../lib/recorder.js';

// The recording provider that replaces the `--vfs-manifest` flag. These mount a
// VFS directly rather than going through `--vfs-mount`, so they exercise the
// provider itself without depending on which startup flags the running node
// has — see the note in the README about the hook a directory mount needs
// before node will select this provider on its own.

const FILES = {
    'index.js': "export const main = true;\n",
    'data.txt': 'payload\n',
    'unused.js': 'export const nope = true;\n',
    'sub/nested.txt': 'nested\n',
};

function fixture() {
    const dir = FS.mkdtempSync(PATH.join(OS.tmpdir(), 'napp-record-'));
    for (const [name, content] of Object.entries(FILES)) {
        const file = PATH.join(dir, name);
        FS.mkdirSync(PATH.dirname(file), { recursive: true });
        FS.writeFileSync(file, content);
    }
    return dir;
}

// Mounts `dir` behind a recording RealFSProvider, runs `body` to completion,
// and returns the recorded lines. `body` is awaited before the unmount: a
// stream opens on a later tick, and a VFS that is no longer mounted resolves
// paths against the real filesystem instead.
async function record(dir, body, options) {
    const out = PATH.join(dir, '..', `${PATH.basename(dir)}.manifest`);
    const manifest = new Manifest(out, { truncate: true, ...options });
    const Recording = recording(VFS.RealFSProvider, manifest);
    const vfs = VFS.create(new Recording(dir), { emitExperimentalWarning: false });
    vfs.mount(dir);
    try {
        await body();
    } finally {
        vfs.unmount();
    }
    return FS.readFileSync(out, 'utf-8').split('\n').filter(Boolean);
}

test('every file read through the mount is recorded, relative to it', async () => {
    const dir = fixture();
    const lines = await record(dir, () => {
        FS.readFileSync(PATH.join(dir, 'index.js'), 'utf-8');
        FS.readFileSync(PATH.join(dir, 'sub/nested.txt'), 'utf-8');
    });
    assert.deepEqual(lines.sort(), ['index.js', 'sub/nested.txt']);
});

test('a file that is never read is never recorded', async () => {
    const dir = fixture();
    const lines = await record(dir, () => {
        FS.readFileSync(PATH.join(dir, 'index.js'), 'utf-8');
    });
    assert.ok(!lines.includes('unused.js'));
});

test('a file read repeatedly is recorded once', async () => {
    const dir = fixture();
    const lines = await record(dir, () => {
        for (let i = 0; i < 5; i++) FS.readFileSync(PATH.join(dir, 'data.txt'));
    });
    assert.deepEqual(lines, ['data.txt']);
});

test('a streamed read is recorded too', async () => {
    const dir = fixture();
    const lines = await record(dir, () => new Promise((resolve, reject) => {
        FS.createReadStream(PATH.join(dir, 'data.txt'))
            .on('data', () => {})
            .on('error', reject)
            .on('end', resolve);
    }));
    assert.deepEqual(lines, ['data.txt']);
});

test('opening a file for writing is not a read', async () => {
    const dir = fixture();
    const lines = await record(dir, () => {
        FS.writeFileSync(PATH.join(dir, 'written.txt'), 'new');
        FS.readFileSync(PATH.join(dir, 'index.js'));
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

test('recording is skipped entirely when no destination is configured', () => {
    const previous = process.env.NAPP_MANIFEST;
    delete process.env.NAPP_MANIFEST;
    try {
        assert.equal(register(), null);
    } finally {
        if (previous !== undefined) process.env.NAPP_MANIFEST = previous;
    }
});

test('the recorded list is what create() consumes', async () => {
    const dir = fixture();
    const lines = await record(dir, () => {
        FS.readFileSync(PATH.join(dir, 'index.js'));
        FS.readFileSync(PATH.join(dir, 'sub/nested.txt'));
    });
    // Every line has to resolve against the mount root as a --base.
    for (const line of lines) assert.ok(FS.existsSync(PATH.join(dir, line)), line);
});
