import test from 'node:test';
import assert from 'node:assert/strict';
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { walk, moduleFiles, dependencyFiles, packageRoot, moduleDir } from '../src/files.ts';
import { scratch } from './helpers.ts';

// Working out the member list the observation run cannot see. The property that
// matters is completeness: a bundle whose closure is short fails at runtime on
// a machine other than the one that built it.

const tmp = scratch('files');
test.after(() => FS.rmSync(tmp, { recursive: true, force: true }));

test('walk lists every file, sorted, and skips nested node_modules', () => {
    const dir = PATH.join(tmp, 'tree');
    for (const name of ['b.js', 'a.js', 'sub/c.js', 'node_modules/dep/index.js']) {
        const file = PATH.join(dir, name);
        FS.mkdirSync(PATH.dirname(file), { recursive: true });
        FS.writeFileSync(file, '');
    }
    assert.deepEqual(walk(dir), ['a.js', 'b.js', 'sub/c.js']);
    assert.deepEqual(walk(dir, { exclude: [] }).includes('node_modules/dep/index.js'), true);
});

test('the dependency closure covers what a lazy require would need', () => {
    // `sigstore.ts` requires @sigstore/verify only when it meets an archive
    // signed that way, so no observation run reaches it — which is exactly the
    // gap this closure exists to fill.
    const files = dependencyFiles(['@sigstore/verify'], packageRoot());
    assert.ok(files.some((name) => name.startsWith('node_modules/@sigstore/verify/')));
    // ...and it is transitive: @sigstore/verify depends on @sigstore/core.
    assert.ok(files.some((name) => name.startsWith('node_modules/@sigstore/core/')),
        'the closure should reach transitive dependencies');
    assert.deepEqual(files, [...new Set(files)], 'no duplicates');
    assert.deepEqual(files, [...files].sort(), 'sorted');
});

test('a dependency that is not installed is skipped rather than fatal', () => {
    assert.deepEqual(dependencyFiles(['@pipobscure/definitely-not-installed'], packageRoot()), []);
});

test('a dependency outside the base cannot be a member, and says so', () => {
    // A hoisted tree: the package resolves, but to a directory above the base,
    // so no relative path can name it as a member. Silently dropping it would
    // produce an archive that is short exactly one dependency.
    const outer = PATH.join(tmp, 'hoisted');
    const inner = PATH.join(outer, 'inner');
    const dep = PATH.join(outer, 'node_modules', 'hoisted-dep');
    FS.mkdirSync(inner, { recursive: true });
    FS.mkdirSync(dep, { recursive: true });
    FS.writeFileSync(PATH.join(inner, 'package.json'), '{"name":"inner"}');
    FS.writeFileSync(PATH.join(dep, 'package.json'), '{"name":"hoisted-dep","main":"index.js"}');
    FS.writeFileSync(PATH.join(dep, 'index.js'), '');

    assert.throws(() => dependencyFiles(['hoisted-dep'], inner), /outside/);
});

test('moduleFiles combines files, directories and dependencies without duplicates', () => {
    const combined = moduleFiles({
        base: packageRoot(),
        files: ['package.json'],
        dirs: ['skills'],
        dependencies: ['@sigstore/protobuf-specs'],
    });
    assert.ok(combined.includes('package.json'));
    assert.ok(combined.includes('skills/audit-bundle/SKILL.md'));
    assert.ok(combined.some((name) => name.startsWith('node_modules/@sigstore/protobuf-specs/')));
    assert.deepEqual(combined, [...new Set(combined)]);
    assert.deepEqual(combined, [...combined].sort());
});

test('a filter keeps the runnable half out of the readable half', () => {
    const runnable = moduleFiles({
        base: packageRoot(),
        dirs: [moduleDir()],
        filter: (name) => !name.endsWith('.map') && !name.endsWith('.d.ts'),
    });
    assert.ok(runnable.length > 0);
    assert.ok(!runnable.some((name) => name.endsWith('.map') || name.endsWith('.d.ts')));
});

test('every file the closure names is really there', () => {
    const root = packageRoot();
    for (const name of moduleFiles({ base: root, files: ['package.json'], dependencies: ['@sigstore/tuf'] })) {
        assert.ok(FS.existsSync(PATH.join(root, name)), name);
    }
});

test('the package root is where package.json is, and the module dir is beside it', () => {
    assert.ok(FS.existsSync(PATH.join(packageRoot(), 'package.json')));
    assert.ok(['src', 'dist'].includes(moduleDir()), moduleDir());
});
