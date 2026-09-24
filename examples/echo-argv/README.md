# echo-argv

Prints its own `process.argv` and exits. Two files and no dependencies — the
smallest thing worth bundling, and a way to answer one question for real:

> when this is a signed archive, do my arguments still arrive?

[`static-server`](../static-server/) is the example of a *shipped application*.
This is the example of a *test fixture*: nothing to read, nothing to explain,
just the three lines it prints.

## Bundle it

```sh
printf 'package.json\nindex.ts\n' > echo-argv.manifest
bundle create --base examples/echo-argv --files echo-argv.manifest --output echo-argv.run
bundle sign --launcher --output echo-argv.nzip echo-argv.run
```

`--launcher` prepends the `#!/bin/sh` prefix this package ships, so the result
runs by name. Signing through sigstore is the default; `--key`/`--chain` sign
against a certificate authority of your own, which is what the repository's own
test PKI (`node tools/testpki.ts`) is for.

## The four shapes, and what each proves

```sh
node --experimental-vfs --vfs-load=examples/echo-argv -- a b     # from source
./echo-argv.nzip a b                                              # the launcher
bundle run --root root.pem echo-argv.nzip a b                     # verifying mount
node --experimental-vfs --vfs-load=echo-argv.nzip -- a b          # mounted by hand
```

All four print the same three lines:

```
runtime: /path/to/node
source:  /path/to/echo-argv.nzip
args:    ["a","b"]
```

Two details that are easy to get wrong and this makes visible:

- **`argv[1]` is the source, not the mount point.** The program can read its own
  bytes, which is how a signed archive verifies itself.
- **`--help`, `-e` and every other node-looking flag reach the program.** The
  launcher prefix ends its node invocation with `--`; without that, node would
  claim them and the program would never see them.

## Several commands in one archive

A symlink to the archive is enough to give it a second name, and the program can
see which name was used. The launcher prefix passes `"$0"` to `--vfs-load`, and
`$0` is the path the archive was *invoked* as — the symlink, not what it points
at. Node passes that string through to `argv[1]` without resolving it:

```sh
ln -s echo-argv.nzip greet
ln -s echo-argv.nzip farewell

./greet x        # source:  /path/to/greet
./farewell x     # source:  /path/to/farewell
```

So one signed file can carry a suite of commands and dispatch on its own name,
the way `busybox` does:

```js
import { basename } from 'node:path';

const command = basename(process.argv[1] ?? '');
const args = process.argv.slice(2);

switch (command) {
    case 'greet':    console.log('hello', ...args); break;
    case 'farewell': console.log('goodbye', ...args); break;
    default:         console.error(`no command named ${command}`); process.exit(64);
}
```

Install it by making one archive and as many symlinks as it has commands. The
bytes exist once, they are signed once, and they are audited once — a suite that
cannot drift out of step with itself, because there is only one of it.

What holds through a symlink:

- **The name reaches the program**, through a relative symlink, an absolute one,
  one in another directory, and one found on `PATH`.
- **Verification is of the archive**, wherever you point at it: `bundle verify
  greet` and `bundle run greet` both open the file the link resolves to, so the
  signature covers the same bytes under every name.

What does not:

- **A copy is not a link.** Copying the archive to a second name works too, but
  then there are two files to sign, to audit and to keep in step.
- **Nothing stops a name it does not know**, so handle the `default` case: the
  archive cannot tell which symlinks someone made.

## Windows

None of the above is `#!`, so none of it is Windows. What replaces it there is
a `.nzip` file association, which `bundle install` registers; the alternatives
and why they lost are in [`windows/`](windows/), and the mechanism itself is
tested by [`test/windows.test.ts`](../../test/windows.test.ts) on every run —
including the one thing no documentation answers, whether a link's name reaches
the program there too. It does.
