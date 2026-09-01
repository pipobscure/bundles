import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { skills, skill, install, DEFAULT_SKILLS_DIR } from '../src/skill.ts';
import { scratch } from './helpers.ts';

// The skills this package ships, and writing them into somebody's project. The
// point of the command is that the review procedure ends up next to whoever is
// about to run an archive rather than staying in this repository.

const tmp = scratch('skill');
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

test('the package carries the auditing skill, with its description', () => {
    const found = skills();
    assert.ok(found.length >= 1);
    const audit = found.find((entry) => entry.name === 'audit-bundle');
    assert.ok(audit, 'audit-bundle should be one of them');
    assert.ok(audit.files.includes('SKILL.md'));
    assert.match(audit.description, /Verify, extract, and security-review/);
    assert.ok(FS.existsSync(PATH.join(audit.source, 'SKILL.md')));
});

test('skills are listed in name order and looked up by name', () => {
    const names = skills().map((entry) => entry.name);
    assert.deepEqual(names, [...names].sort());
    assert.equal(skill('audit-bundle')?.name, 'audit-bundle');
    assert.equal(skill('no-such-skill'), null);
});

test('installing writes every file of the skill under <dir>/<name>', () => {
    const dir = PATH.join(tmp, 'project', '.claude', 'skills');
    const res = install('audit-bundle', { dir });
    assert.equal(res.name, 'audit-bundle');
    assert.equal(res.path, PATH.join(dir, 'audit-bundle'));
    assert.deepEqual(res.skipped, []);
    assert.ok(res.written.length >= 1);
    for (const file of res.written) assert.ok(FS.existsSync(file), file);

    const installed = FS.readFileSync(PATH.join(res.path, 'SKILL.md'), 'utf-8');
    const original = FS.readFileSync(PATH.join(skill('audit-bundle')!.source, 'SKILL.md'), 'utf-8');
    assert.equal(installed, original);
});

test('a second install leaves local edits alone unless forced', () => {
    const dir = PATH.join(tmp, 'edits');
    install('audit-bundle', { dir });
    const file = PATH.join(dir, 'audit-bundle', 'SKILL.md');
    FS.writeFileSync(file, 'edited by hand\n');

    const again = install('audit-bundle', { dir });
    assert.deepEqual(again.written, []);
    assert.deepEqual(again.skipped, [file]);
    assert.equal(FS.readFileSync(file, 'utf-8'), 'edited by hand\n');

    const forced = install('audit-bundle', { dir, force: true });
    assert.deepEqual(forced.skipped, []);
    assert.match(FS.readFileSync(file, 'utf-8'), /Auditing a bundle/);
});

test('an unknown skill is refused, and says what there is', () => {
    assert.throws(() => install('nonesuch', { dir: PATH.join(tmp, 'unused') }),
        /unknown skill: nonesuch.*audit-bundle/s);
});

test('the default destination is where Claude Code looks', () => {
    assert.equal(DEFAULT_SKILLS_DIR, PATH.join('.claude', 'skills'));
});
