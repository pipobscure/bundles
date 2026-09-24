import { DynamicLibrary, getRawPointer, setUint64, suffix } from 'node:ffi';
import { basename, dirname, join } from 'node:path';

// A command-line tool whose actual program is not JavaScript.
//
// The archive carries a Rust shared library beside this file. This file is the
// entry point node resolves out of the mount; all it does is hand the library
// the arguments in the shape a C `main` expects, and exit with what comes back.
// Nothing here knows any Rust, and the Rust knows no node: the contract is one
// C symbol, `bundle_main(argc, argv) -> int`.
//
// That is the point of the experiment. If a package manager were written in
// Rust, C++ or Zig, it could still ship as one signed archive, be observed and
// audited the same way, and start through the same `--vfs-load` path — with the
// runtime agnostic about what is inside.
//
//   node --experimental-vfs --vfs-load=. -- echo one two
//   ./native-cli.nzip echo one two
//
// The library is opened straight out of the mount. That is not obvious: `dlopen`
// wants an inode and a mounted path has none, which is why loading `.node`
// addons from a VFS needed its own pull request (nodejs/node#65680). `node:ffi`
// gets the same treatment — it reads the bytes out of the mount and loads them
// from a private, self-cleaning image — so no temporary copy is needed here, and
// the bytes that get loaded are the ones the provider just checked against their
// signed digest.

const LIBRARY = `libnative_cli.${suffix}`;

/**
 * The arguments as a C `main` takes them: `argc`, and an array of pointers to
 * NUL-terminated strings. The buffers are held in one array for the duration of
 * the call — dropping them early would leave the library reading freed memory.
 */
function argv(args: string[]): { argc: number; pointers: Buffer; keep: Buffer[] } {
    const keep = args.map((arg) => Buffer.from(`${arg}\0`, 'utf-8'));
    const pointers = Buffer.alloc(keep.length * 8);
    const base = getRawPointer(pointers);
    keep.forEach((buffer, index) => setUint64(base, index * 8, getRawPointer(buffer)));
    return { argc: keep.length, pointers, keep };
}

const lib = new DynamicLibrary(join(dirname(import.meta.filename), LIBRARY));
try {
    const main = lib.getFunction('bundle_main', { arguments: ['int32', 'pointer'], return: 'int32' });

    // argv[0] is the name this was invoked as — the archive's own path, or the
    // symlink someone made to it, which is how one archive answers to several
    // command names.
    const { argc, pointers, keep } = argv([basename(process.argv[1] ?? 'native-cli'), ...process.argv.slice(2)]);
    process.exitCode = main(argc, pointers);
    // Named so it is clear this is not dead code: the buffers argv points into
    // have to outlive the call, and this is what keeps them alive until it.
    keep.length = 0;
} finally {
    lib.close();
}
