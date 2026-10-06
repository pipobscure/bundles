#!/usr/bin/env node
import * as FS from 'node:fs';
import * as PATH from 'node:path';
import { packageRoot, packageVersion } from '../src/files.ts';
import { schemaUrl } from '../src/policy.ts';

// The JSON Schema for policy files, as a release publishes it.
//
// The source in `schemas/policy.schema.json` names the latest release as its
// `$id`. The copy attached to a release names that release instead, because
// that is the URL `bundle policy init` writes into a policy file — and the
// `$id` of a schema should be where it is served.
//
//   node tools/schema.ts [output]     (default: build/policy.schema.json)

export const SOURCE = PATH.join(packageRoot(), 'schemas', 'policy.schema.json');

/** The schema as released for `version`. */
export function releasedSchema(version: string = packageVersion()): string {
    const schema = JSON.parse(FS.readFileSync(SOURCE, 'utf-8')) as Record<string, unknown>;
    return `${JSON.stringify({ ...schema, $id: schemaUrl(version) }, null, 2)}\n`;
}

if (import.meta.main) {
    const output = PATH.resolve(process.argv[2] ?? PATH.join(packageRoot(), 'build', 'policy.schema.json'));
    FS.mkdirSync(PATH.dirname(output), { recursive: true });
    FS.writeFileSync(output, releasedSchema());
    console.error(`* wrote ${output} ($id ${schemaUrl(packageVersion())})`);
}
