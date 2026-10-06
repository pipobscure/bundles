import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { complete, respond, splitLine, script, startupFile, hookLine, addHook, removeHooks, hasHook, detectShell } from '../src/completion.ts';
import { COMMANDS, OPTIONS, USAGE, main } from '../src/cli.ts';
import { recordPath } from '../src/install.ts';
import { collector, scratch } from './helpers.ts';

// Tab completion: what is offered, how each shell is answered, and the shell
// setup `bundle install` offers to add.

const tmp = scratch('completion');
process.env['XDG_STATE_HOME'] = PATH.join(tmp, 'state');
process.env['LOCALAPPDATA'] = PATH.join(tmp, 'AppData');
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

const values = async (words: string[], current: string) => (await complete(words, current)).candidates.map(({ value }) => value);

test('commands, their options and their values are offered', async () => {
    assert.deepEqual(await values([], ''), Object.keys(COMMANDS));
    assert.deepEqual(await values([], 'va'), ['validate']);
    assert.deepEqual(await values([], '--'), ['--help', '--version']);
    assert.ok(!(await values([], '')).includes('__complete'), 'the hidden entry point is not offered');

    // Every option a command accepts, and `--no-` for those that default on.
    const install = await values(['install'], '--');
    for (const name of Object.keys(OPTIONS.install)) assert.ok(install.includes(`--${name}`), name);
    assert.ok(install.includes('--no-discover') && install.includes('--no-shell'));

    assert.deepEqual(await values(['attest', '--verdict'], ''), ['good', 'bad']);
    assert.deepEqual(await values(['sign'], '--flow=b'), ['--flow=browser']);
    assert.deepEqual(await values(['policy'], ''), ['show', 'init', 'check']);
    assert.deepEqual(await values(['shell'], 'f'), ['fish']);
    assert.deepEqual(await values(['lexicon', 'check'], ''), []);
});

test('files are left to the shell, where a file goes', async () => {
    assert.equal((await complete(['verify'], 'READ')).files, true);
    assert.equal((await complete(['sign', '-r'], '')).files, true, 'a short option taking a file');
    assert.equal((await complete(['policy', 'check'], '')).files, true);
    // `run`'s own options end at the archive; what follows is the program's.
    assert.equal((await complete(['run', '--untrusted'], '')).files, true);
    assert.equal((await complete(['run', './app'], '--')).candidates.length, 0);
    assert.equal((await complete(['run', '--root', 'ca.pem', './app'], '')).files, true);
});

test('installed names are offered where an install is named', async () => {
    FS.mkdirSync(PATH.dirname(recordPath()), { recursive: true });
    const record = (name: string) => ({ name, url: `https://example.com/${name}.nzip`, sha256: 'x', at: '', dir: tmp });
    FS.writeFileSync(recordPath(), JSON.stringify({ version: 1, installs: { pnpm: record('pnpm'), tool: record('tool') } }));
    assert.deepEqual(await values(['update'], ''), ['pnpm', 'tool']);
    assert.deepEqual(await values(['uninstall'], 'p'), ['pnpm']);
    assert.deepEqual(await values(['validate', 'pnpm'], 't'), ['tool']);
    assert.deepEqual(await values(['policy', '--app'], ''), ['pnpm', 'tool']);
});

test('each shell is answered the way it asks', async () => {
    // bash hands over the line, and replaces only what follows its last word break.
    const bash = await respond(['--shell', 'bash', 'bundle', 'b', '--flow'], { COMP_LINE: 'bundle sign --flow=b', COMP_POINT: '20' });
    assert.deepEqual(bash, ['browser']);
    assert.deepEqual(await respond(['--shell', 'bash'], { COMP_LINE: 'bundle verify RE', COMP_POINT: '16' }), [], 'files: nothing, so bash falls back');
    // zsh's bash emulation replaces the whole word.
    assert.deepEqual(await respond(['--shell', 'zsh'], { COMP_LINE: 'bundle sign --flow=b', COMP_POINT: '20' }), ['--flow=browser']);
    // fish passes words, and shows descriptions.
    const fish = await respond(['--shell', 'fish', '--', 'install', '--att']);
    assert.deepEqual(fish, ['--attester\trequire an attestation from this DID or handle; repeatable']);
    assert.deepEqual(await respond(['--shell', 'fish', '--', 'verify', '']), [':files']);
    // The cursor, not the end of the line, is what counts.
    assert.deepEqual(await respond(['--shell', 'zsh'], { COMP_LINE: 'bundle va --json', COMP_POINT: '9' }), ['validate']);
});

test('a command line is split as the shell would', () => {
    assert.deepEqual(splitLine('bundle verify "my app.nzip" --ro'), { words: ['bundle', 'verify', 'my app.nzip'], current: '--ro' });
    assert.deepEqual(splitLine("bundle sign it\\'s "), { words: ['bundle', 'sign', "it's"], current: '' });
    assert.deepEqual(splitLine('bundle '), { words: ['bundle'], current: '' });
});

test('the CLI answers on Tab, and never fails loudly doing it', async () => {
    const io = collector();
    assert.equal(await main(['__complete', '--shell', 'fish', '--', 'attest', '--verdict', 'b'], io), 0);
    assert.deepEqual(io.stdout, ['bad']);
    const nothing = collector();
    assert.equal(await main(['__complete', '--shell', 'fish', '--', 'no-such-command', ''], nothing), 0);
    assert.deepEqual(nothing.stdout, []);
});

test('the usage text documents every option each command accepts', () => {
    const lines = USAGE.split('\n');
    const undocumented: string[] = [];
    for (const [command, options] of Object.entries(OPTIONS)) {
        const start = lines.findIndex((line) => line.startsWith(`${command} options:`));
        let end = lines.findIndex((line, i) => i > start && /^\S/.test(line));
        if (end < 0) end = lines.length;
        // `sea` takes `sign`'s signing options, and says so rather than repeating them.
        const own = lines.slice(start, end).join('\n');
        const section = command === 'sea' ? own + lines.slice(lines.findIndex((line) => line.startsWith('sign options:'))).join('\n') : own;
        for (const [name, option] of Object.entries(options as Record<string, { type: string; default?: unknown }>)) {
            const spelled = option.type === 'boolean' && option.default === true ? `--no-${name}` : `--${name}`;
            if (start < 0 || !new RegExp(`${spelled}\\b`).test(section)) undocumented.push(`${command} ${spelled}`);
        }
    }
    assert.deepEqual(undocumented, []);
});

test('the shell setup wires completion, and re-validates interactive shells quietly', () => {
    for (const shell of ['bash', 'zsh', 'fish']) {
        const text = script(shell);
        assert.match(text, /__complete --shell/);
        assert.match(text, /bundle validate --quiet --every 1d --timeout 5s/);
        assert.match(text, shell === 'bash' ? /\$- == \*i\*/ : shell === 'zsh' ? /-o interactive/ : /status is-interactive/);
        assert.doesNotMatch(script(shell, { validate: false }), /validate/);
        assert.doesNotMatch(script(shell, { complete: false }), /__complete/);
    }
    assert.match(script('fish'), /complete -c bundle -e/, "fish's completions for Ruby's bundle are replaced");
    assert.match(script('bash', { every: '12h', timeout: '2s' }), /--every 12h --timeout 2s/);
    assert.throws(() => script('tcsh'), /no support for 'tcsh'/);
});

test('the startup-file block is added once, and taken out leaving the file as it was', () => {
    const home = PATH.join(tmp, 'home');
    FS.mkdirSync(home, { recursive: true });
    const env = { HOME: home, SHELL: '/usr/bin/zsh' };
    assert.equal(detectShell(env), 'zsh');
    assert.equal(detectShell({ SHELL: '/bin/tcsh' }), null);
    assert.equal(detectShell({}), null, 'cmd.exe and PowerShell set no SHELL');
    // Git Bash on Windows is bash, however its path is written.
    assert.equal(detectShell({ SHELL: '/usr/bin/bash' }), 'bash');
    assert.equal(detectShell({ SHELL: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe' }), 'bash');
    assert.equal(startupFile('fish', env), PATH.join(home, '.config', 'fish', 'config.fish'));
    assert.equal(startupFile('zsh', { ...env, ZDOTDIR: PATH.join(home, 'zdot') }), PATH.join(home, 'zdot', '.zshrc'));

    const zshrc = PATH.join(home, '.zshrc');
    FS.writeFileSync(zshrc, 'setopt autocd');                          // no final newline
    assert.deepEqual(addHook('zsh', env), { file: zshrc, added: true });
    assert.deepEqual(addHook('zsh', env), { file: zshrc, added: false });
    const text = FS.readFileSync(zshrc, 'utf-8');
    assert.equal(text.split(hookLine('zsh')).length, 2, 'the line is there exactly once');
    assert.ok(hasHook(zshrc));

    assert.deepEqual(addHook('fish', env).added, true);              // a file that did not exist
    // Installed as `bundle.nzip` (Windows, run from Git Bash), it is that name the hook runs.
    assert.equal(hookLine('bash', 'bundle.nzip'), 'command -v bundle.nzip >/dev/null 2>&1 && eval "$(bundle.nzip shell bash)"');
    assert.match(script('bash', {}, 'bundle.nzip'), /complete -o default -C 'bundle\.nzip __complete --shell bash' bundle\.nzip/);
    assert.deepEqual(removeHooks(env).sort(), [startupFile('fish', env), zshrc].sort());
    assert.equal(FS.readFileSync(zshrc, 'utf-8'), 'setopt autocd\n');
    assert.equal(FS.readFileSync(startupFile('fish', env), 'utf-8'), '');
    assert.deepEqual(removeHooks(env), [], 'nothing left to take out');
});
