import { parseArgs } from 'node:util';

export const USAGE = `usage: static-server [options] <source>...

Serves the contents of every source given, merged into one tree, in the order
given — an earlier source shadows a later one. A source is a directory or a ZIP
archive; which it is comes from the file itself, not from its name.

  --host=<addr>     address to listen on (default localhost; 0.0.0.0 for all)
  --port=<n>        port to listen on (default 8080; 0 picks a free one)
  --max-age=<secs>  freshness for ordinary files (default 3600)
  --redirects=<f>   JSON file of redirect rules, applied before anything is served
  --no-listing      404 a directory that has no index.html, instead of listing it
  --help

  ./static-server.run ./site docs.zip
  ./static-server.run --host=0.0.0.0 --port=8080 ./site docs.zip
`;

export interface Options {
    help: boolean;
    sources: string[];
    host: string;
    port: number;
    maxAge: number;
    redirects: string | undefined;
    listing: boolean;
}

export function parse(argv: string[]): Options {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            'host': { type: 'string' },
            'port': { type: 'string' },
            'max-age': { type: 'string' },
            'redirects': { type: 'string' },
            'no-listing': { type: 'boolean' },
            'help': { type: 'boolean', short: 'h' },
        },
    });

    return {
        help: values.help === true,
        sources: positionals,
        host: values.host ?? 'localhost',
        port: number(values.port, 'port', Number(process.env['PORT'] ?? 8080)),
        maxAge: number(values['max-age'], 'max-age', 3600),
        redirects: values.redirects,
        listing: values['no-listing'] !== true,
    };
}

function number(value: string | undefined, name: string, fallback: number): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${name} takes a non-negative integer`);
    return parsed;
}
