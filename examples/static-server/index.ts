import { createServer } from 'node:http';
import { parse, USAGE } from './lib/args.ts';
import { mountAll, type Mount } from './lib/mounts.ts';
import { handle } from './lib/serve.ts';

// A static web server that serves what it is handed: directories, ZIP archives,
// or a mix of both, merged into one tree.
//
// It is an example of a *shipped application* rather than a script — five
// modules and a stylesheet, resolved against each other, with an entry point
// named by its own `package.json`. Bundled, that whole tree becomes one signed
// file and `--vfs-load` runs it out of the archive, assets included, which is
// the part a bundler cannot do for you.
//
//   node --experimental-vfs --vfs-load=. ./site docs.zip
//   ./static-server.run ./site docs.zip
//
// The second form is this same tree signed behind the launcher prefix this
// package ships. Everything after the archive's own name reaches this program,
// because that prefix ends its node invocation with `--`.

const options = parse(process.argv.slice(2));

if (options.help) {
    process.stdout.write(USAGE);
    process.exit(0);
}

// Serving nothing is allowed, and useful: the root still answers with the
// enumeration — an empty one — which is every generated page's code path and
// every file this program needs. One request to a server with no sources is
// therefore a complete observation run.
if (options.sources.length === 0) {
    process.stderr.write('static-server: nothing to serve; the root will say so\n');
}

let mounts: Mount[];
try {
    mounts = mountAll(options.sources);
} catch (error) {
    process.stderr.write(`static-server: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(66);
}

const server = createServer((req, res) => {
    try {
        handle(req, res, { mounts, listing: options.listing, maxAge: options.maxAge });
    } catch (error) {
        // A handler that throws still has to answer: a hung socket is worse than
        // a 500, and an example that swallows the reason is worse than both.
        process.stderr.write(`static-server: ${req.method} ${req.url} — ${String(error)}\n`);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 internal server error\n');
    }
});

server.listen(options.port, options.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : options.port;
    // A bare IPv6 address needs brackets in a URL, and a wildcard bind is not an
    // address anyone can type into a browser.
    let host = options.host === '0.0.0.0' || options.host === '::' ? 'localhost' : options.host;
    if (host.includes(':')) host = `[${host}]`;
    process.stdout.write(`static-server: http://${host}:${port}\n`);
    for (const mount of mounts) {
        process.stdout.write(`  ${mount.kind.padEnd(9)} ${mount.source}\n`);
    }
});

// Ctrl-C during a demo should look like an exit, not a stack trace.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        server.close(() => process.exit(0));
        // Stop waiting on the keep-alive connections a browser holds open.
        server.closeIdleConnections();
    });
}
