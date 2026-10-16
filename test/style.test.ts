import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAIN, fancy, styleFor, bytes, plural, MARKS } from '../src/style.ts';
import { main } from '../src/cli.ts';
import { scratch, tree, build, collector, ROOT_PEM } from './helpers.ts';
import * as PATH from 'node:path';

test('the plain style changes nothing: a pipe gets exactly the documented text', () => {
    for (const fn of [PLAIN.bundle, PLAIN.signature, PLAIN.attestation, PLAIN.bold, PLAIN.dim, PLAIN.red, PLAIN.line]) {
        assert.equal(fn('* some text'), '* some text');
    }
    assert.equal(PLAIN.note('fetching x', 'bundle'), '* fetching x');
    assert.equal(PLAIN.warn('careful'), '! careful');
    assert.equal(PLAIN.error('broken'), 'error: broken');
    assert.equal(PLAIN.state('valid', 'VALID'), 'VALID');
});

test('only a terminal gets people\'s formatting', () => {
    assert.equal(styleFor({ isTTY: false }), PLAIN);
    assert.equal(styleFor({}), PLAIN);
    assert.equal(styleFor({ isTTY: true }, { TERM: 'dumb' }), PLAIN);
    assert.equal(styleFor({ isTTY: true }, {}, 'linux').people, true);
});

test('colour follows the terminal, so NO_COLOR is honoured where node honours it', () => {
    const withColour = styleFor({ isTTY: true, hasColors: () => true }, {}, 'linux');
    const without = styleFor({ isTTY: true, hasColors: () => false }, {}, 'linux');
    assert.match(withColour.bold('x'), /\x1b\[1mx\x1b\[22m/);
    assert.equal(without.bold('x'), 'x');
    assert.equal(without.bundle('app'), `${MARKS.bundle} app`);
});

test('a Windows console without Windows Terminal gets no emoji, which it would draw as boxes', () => {
    assert.equal(styleFor({ isTTY: true }, {}, 'win32').bundle('app'), 'app');
    assert.equal(styleFor({ isTTY: true }, { WT_SESSION: '1' }, 'win32').bundle('app'), '🌳 app');
});

test('the three marks mean one thing each', () => {
    const style = fancy({ color: false });
    assert.equal(style.bundle('app'), '🌳 app');
    assert.equal(style.signature('signed'), '🔐 signed');
    assert.equal(style.attestation('attested'), '✍️ attested');
    assert.equal(style.note('signing', 'signature'), '🔐 signing');
    assert.equal(style.note('syncing'), '› syncing');
    assert.equal(fancy({ color: false, emoji: false }).note('signing', 'signature'), '› signing');
});

test('log lines from other modules keep their words and get people\'s markers', () => {
    const style = fancy({ color: false });
    assert.equal(style.line('* fetching https://x'), '› fetching https://x');
    assert.equal(style.line('  ! not on your PATH'), '  ⚠ not on your PATH');
    assert.equal(style.line('error: no'), '✖ error: no');
    assert.equal(style.line('  accepted: 1 of 1'), '  accepted: 1 of 1');
});

test('sizes and counts read as a person would say them', () => {
    assert.equal(bytes(77), '77 B');
    assert.equal(bytes(1536), '1.5 kB');
    assert.equal(bytes(4 * 1024 * 1024), '4.0 MB');
    assert.equal(bytes(150 * 1024 * 1024), '150 MB');
    assert.equal(plural(1, 'member'), '1 member');
    assert.equal(plural(3, 'member'), '3 members');
});

test('verify on a terminal leads with the bundle and its state, and marks the signature', async () => {
    const dir = scratch('style-verify');
    const signed = await build(tree(dir), PATH.join(dir, 'app.nzip'));
    const io = { ...collector(), style: { out: fancy({ color: false }), err: fancy({ color: false }) } };
    assert.equal(await main(['verify', '--root', ROOT_PEM, signed], io), 0);
    const [first, ...rest] = io.stdout.join('\n').split('\n');
    assert.equal(first, `🌳 ${signed}  ✔ VALID`);
    assert.ok(rest.some((line) => line.startsWith('   🔐 ')), rest.join('\n'));
    assert.ok(rest.some((line) => /^ {3}hash {6}sha256:[0-9a-f]{64}$/.test(line)), rest.join('\n'));
});
