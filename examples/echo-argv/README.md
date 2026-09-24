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
bundle create --base examples/echo-argv --files echo-argv.manifest --output echo-argv.bundle
bundle sign --launcher --output echo-argv.run echo-argv.bundle
```

`--launcher` prepends the `#!/bin/sh` prefix this package ships, so the result
runs by name. Signing through sigstore is the default; `--key`/`--chain` sign
against a certificate authority of your own, which is what the repository's own
test PKI (`node tools/testpki.ts`) is for.

## The four shapes, and what each proves

```sh
node --experimental-vfs --vfs-load=examples/echo-argv -- a b     # from source
./echo-argv.run a b                                              # the launcher
bundle run --root root.pem echo-argv.run -- a b                  # verifying mount
node --experimental-vfs --vfs-load=echo-argv.run -- a b          # mounted by hand
```

All four print the same three lines:

```
runtime: /path/to/node
source:  /path/to/echo-argv.run
args:    ["a","b"]
```

Two details that are easy to get wrong and this makes visible:

- **`argv[1]` is the source, not the mount point.** The program can read its own
  bytes, which is how a signed archive verifies itself.
- **`--help`, `-e` and every other node-looking flag reach the program.** The
  launcher prefix ends its node invocation with `--`; without that, node would
  claim them and the program would never see them.
