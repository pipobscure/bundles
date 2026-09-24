# native-cli

A command-line tool whose program is **not JavaScript**. The archive carries a
Rust shared library; the entry point node resolves out of the mount is a
thirty-line stub that hands it `argc`/`argv` through [`node:ffi`](https://nodejs.org/api/ffi.html)
and exits with what comes back.

The contract between the two halves is one C symbol:

```rust
pub unsafe extern "C" fn bundle_main(argc: c_int, argv: *const *const c_char) -> c_int
```

Nothing in the Rust knows about node, and nothing in the stub knows about Rust.
Swap the library for one written in C++, Zig or Go and neither side notices.

## Why this exists

If a package manager — or any tool a runtime wants to ship without being
opinionated about — were written in something other than JavaScript, could it
still arrive the same way: one signed file, observed and audited as a closed
set, started through `--vfs-load`?

Yes. Everything below was run rather than assumed.

## Build and run it

```sh
cd rust && cargo build --release && cd ..
cp rust/target/release/libnative_cli.so .      # .dylib on macOS, .dll on Windows

node --experimental-vfs --vfs-load=. -- echo one two
```

Then bundle it the way anything else is bundled:

```sh
printf 'package.json\nindex.ts\nlibnative_cli.so\n' > native-cli.manifest
bundle create --base examples/native-cli --files native-cli.manifest --output native-cli.run
bundle sign --launcher --output native-cli.nzip native-cli.run

./native-cli.nzip echo alpha beta
```

The signed archive is 165 KB, three members, and runs by name.

## What it demonstrates

**`dlopen` works straight out of the mount.** This is the part worth knowing.
A mounted path has no inode, and `dlopen` wants one — which is why loading
`.node` addons from a VFS needed [its own pull request](https://github.com/nodejs/node/pull/65680).
`node:ffi` gets the same treatment: it reads the bytes out of the mount and
loads them from a private image, so there is no temporary copy in this example
and nothing to clean up. An earlier draft staged the library into `os.tmpdir()`
first; it turned out to be unnecessary. (`copyFileSync` out of a mount fails
with `EXDEV` anyway — copying across a VFS boundary is not a copy node will
make for you.)

**The signature covers the native code.** Flipping one byte inside the archive
gives `INVALID — archive hash does not match the recorded hash`, and
`bundle run` refuses with exit 2. The machine code is a member like any other,
re-hashed against its signed digest as it is read.

**`argv[0]` is the invoked name**, so the busybox trick works here too:

```sh
ln -s native-cli.nzip pkg
./pkg status        # program: pkg
```

**The exit code is the library's.** `./native-cli.nzip fail` exits 3, decided by
the Rust.

## The argv marshalling, since it is the only fiddly part

`node:ffi` passes a `Buffer` as a pointer to its own memory, so a C `argv` is a
buffer of pointers into other buffers:

```js
const keep = args.map((arg) => Buffer.from(`${arg}\0`, 'utf-8'));
const pointers = Buffer.alloc(keep.length * 8);
const base = getRawPointer(pointers);
keep.forEach((buffer, i) => setUint64(base, i * 8, getRawPointer(buffer)));
main(keep.length, pointers);
```

`keep` is not decoration: those buffers have to stay reachable for the duration
of the call, or the library reads freed memory.

## One archive, every architecture

The `.so` this example carries is for one platform and one architecture, because
one is all it needs. That is not the limit it looks like: an archive is a file
*tree*, so a real tool carries a library per target and binds the right one at
startup.

```js
const lib = new DynamicLibrary(join(dirname(import.meta.filename),
    'lib', `${process.platform}-${process.arch}`, `core.${suffix}`));
```

```
lib/linux-x64/core.so       lib/darwin-arm64/core.dylib
lib/linux-arm64/core.so     lib/win32-x64/core.dll
```

Still one file, one signature, one audit, on every machine. What it costs is
bytes — everyone gets every architecture — so publishing per-platform archives
stays available when that trade is the wrong one.

The one thing to do deliberately is the **file list**: an observation run sees
only the library it loaded, so the others have to be added on purpose. That is
what a computed closure is for (see [`moduleFiles`](../../README.md#using-it-from-code)),
and the audit then reviews every one of them — which is the point, since the
architectures you are not running are the ones nobody looks at.

## What this does not answer

- **Windows.** `suffix` is `dll` there and the launcher problem is its own
  question; see [`../echo-argv/windows/`](../echo-argv/windows/).
- **Whether this should be a `.node` addon instead.** If the native side wants
  to talk to node — allocate JS values, take callbacks — N-API is the right
  interface and this one is not. The C `main` shape is for a program that
  happens to be started by node rather than written for it.
