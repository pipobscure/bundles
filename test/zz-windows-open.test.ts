import test from 'node:test';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import * as ZLIB from 'node:zlib';
import { spawn } from 'node:child_process';
import { APP, scratch, tree, plainZip } from './helpers.ts';

// A probe, not a test: what can be done on this platform to an archive that
// something has open — the ways bundle holds one — and whether the holder can
// still read from it afterwards. It reports, and never fails.

const tmp = scratch('open-probe');
const source = tree(tmp, APP);
const template = await plainZip(source, PATH.join(tmp, 'template.zip'));
const replacement = await plainZip(source, PATH.join(tmp, 'replacement.zip'));
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

type Hold = { read(): string; close(): void | Promise<void> };
const VFS = process.getBuiltinModule('node:vfs') as unknown as {
    create(provider: unknown, options: unknown): { mount(): string; unmount(): void }; ZipProvider: new (archive: unknown) => unknown;
};

const holders: Record<string, (file: string) => Promise<Hold>> = {
    'fs.openSync': async (file) => {
        const fd = FS.openSync(file, 'r');
        return { read: () => { const b = Buffer.alloc(4); FS.readSync(fd, b, 0, 4, 0); return b.toString('hex'); }, close: () => FS.closeSync(fd) };
    },
    'ZipFile.openSync': async (file) => {
        const zip = ZLIB.ZipFile.openSync(file);
        return { read: () => zip.getSync('greet.js').contentSync().toString().slice(0, 12), close: () => zip.closeSync() };
    },
    'mounted (ZipProvider)': async (file) => {
        const zip = ZLIB.ZipFile.openSync(file);
        const vfs = VFS.create(new VFS.ZipProvider(zip), { emitExperimentalWarning: false });
        const root = vfs.mount();
        return { read: () => FS.readFileSync(PATH.join(root, 'sub', 'tag.js'), 'utf-8').slice(0, 12), close: () => { vfs.unmount(); zip.closeSync(); } };
    },
    'an app run with --vfs-load': async (file) => {
        const child = spawn(process.execPath, ['--no-warnings', '--experimental-vfs', '--vfs-load', file, '-e',
            "process.stdin.on('data', () => { try { process.stdout.write(require('fs').readFileSync(require('path').join(process.argv[1] ? '' : '', '/dev/null/vfs/0/greet.js'), 'utf-8').slice(0, 12) + '\\n'); } catch (e) { process.stdout.write('ERR ' + e.code + '\\n'); } }); console.log('ready');"],
            { stdio: ['pipe', 'pipe', 'inherit'] });
        let buffered = '';
        const next = () => new Promise<string>((resolve) => {
            const on = (chunk: Buffer) => { buffered += chunk; const i = buffered.indexOf('\n'); if (i >= 0) { child.stdout.off('data', on); const line = buffered.slice(0, i); buffered = buffered.slice(i + 1); resolve(line); } };
            child.stdout.on('data', on);
        });
        await next();
        let last = '';
        return {
            read: () => last,
            close: async () => { child.kill(); await new Promise((r) => child.once('exit', r)); },
            // read through the child, asynchronously
            ...{ async readAsync() { child.stdin.write('x\n'); last = await next(); return last; } },
        } as Hold;
    },
};

const attempt = (action: () => void): string => {
    try { action(); return 'ok'; } catch (err) { return (err as { code?: string }).code ?? String(err); }
};

test('what can be done to an archive something has open', async (t) => {
    const rows: Record<string, Record<string, string>> = {};
    for (const [name, hold] of Object.entries(holders)) {
        const row: Record<string, string> = {};
        const readOf = async (h: Hold) => ((h as unknown as { readAsync?: () => Promise<string> }).readAsync ? await (h as unknown as { readAsync: () => Promise<string> }).readAsync() : attempt(() => { h.read(); }) === 'ok' ? h.read() : 'ERR');
        for (const op of ['replace', 'aside, then in', 'delete'] as const) {
            const dir = PATH.join(tmp, `${name.replace(/\W+/g, '-')}-${op.replace(/\W+/g, '-')}`);
            FS.mkdirSync(dir, { recursive: true });
            const target = PATH.join(dir, 'app.nzip');
            const incoming = PATH.join(dir, 'app.nzip.incoming');
            FS.copyFileSync(template, target);
            FS.copyFileSync(replacement, incoming);
            const h = await hold(target);
            const before = await readOf(h);
            let result: string;
            if (op === 'replace') result = attempt(() => FS.renameSync(incoming, target));
            else if (op === 'delete') result = attempt(() => FS.unlinkSync(target));
            else {
                const aside = attempt(() => FS.renameSync(target, `${target}.previous`));
                result = aside === 'ok' ? `aside ok, in ${attempt(() => FS.renameSync(incoming, target))}` : `aside ${aside}`;
            }
            const after = await readOf(h);
            row[op] = `${result}; still reads: ${after === before ? 'yes' : after}`;
            if (op === 'aside, then in' && result.startsWith('aside ok')) row['delete the old one, still open'] = attempt(() => FS.unlinkSync(`${target}.previous`));
            await h.close();
        }
        rows[name] = row;
    }
    t.diagnostic(`${process.platform} ${process.version}\n${JSON.stringify(rows, null, 2)}`);
    console.log(`OPEN-PROBE ${JSON.stringify({ platform: process.platform, rows })}`);
});
