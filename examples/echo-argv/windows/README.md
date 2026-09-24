# Running a bundle on Windows

Everything this package does on Unix rests on a two-line `#!/bin/sh` prefix:
the kernel hands the file to `sh`, `sh` hands it to node as `--vfs-load="$0"`,
and `$0` is the path the file was *invoked* as — so a symlink gives the program
its own name back. Windows has no `#!`, so the question is what replaces it.

There are three candidates, and they are not equally good.

## 1. A `.cmd` prefix — the direct translation, and the one that lost

```bat
@echo off
node --no-warnings --experimental-vfs --vfs-load="%~f0" -- %*
exit /b %errorlevel%
```

then the archive, with a Ctrl-Z (0x1A) between them. `%~f0` is documented as
"expands %1 to a fully qualified path" applied to the script itself, and `%0`
is the script as invoked, which is the property the whole naming trick needs.

Built and checked here: the archive stays a valid ZIP, the signature still
verifies, and `--vfs-load` still mounts it, because the provider picks by
content and never looks at the name.

**It works** — a run on Windows confirmed that cmd.exe stops at `exit /b` and
never reads on into the ZIP, which no documentation states. (One rule does
follow from what is documented: such a prefix may use only `exit /b` or
`goto :EOF`, never `goto :label`, because a label search reads the whole file
looking for it.)

**It is not what this package does**, because the association below covers the
same ground for one artifact instead of two, and the prefix has a sharp edge of
its own: when cmd finds the file through PATHEXT, `%~f0` gives the name *as
typed*, without the extension, so the file cannot find itself without guessing
at what it is called.

## 2. A file association — the one this package uses

```bat
assoc .nzip=NodeBundle
ftype NodeBundle="%ProgramFiles%\nodejs\node.exe" --experimental-vfs --vfs-load="%1" -- %~2
setx /M PATHEXT "%PATHEXT%;.NZIP"
```

Now `myapp.nzip` runs as `myapp`, with no prefix in the file at all. The
`ftype` reference documents exactly this, down to the PATHEXT trick: "To
eliminate the need to type the .pl file name extension when invoking a Perl
script". Use `%~2` rather than `%*` for the arguments — `%1` is the launched
file and the rest start at `%2`, so `%1 %*` would pass them twice.

This is the route worth wanting, because **one file then works on every
platform**: Unix ignores the extension and uses the `#!` prefix, Windows
ignores the prefix and uses the extension. Same bytes, same digest, same
signature, one thing to audit.

Its cost is that it is machine setup rather than something the file carries:
`assoc`/`ftype` write through `HKEY_CLASSES_ROOT` into HKLM and need
administrator rights, and a per-user default in HKCU shadows them. It belongs
in an installer — which is the interesting case: a runtime that shipped its
tooling as signed bundles could register the type once, and every bundle
afterwards would just work.

## 3. PowerShell — no

PowerShell compiles a script to an AST before running any of it, and has no
documented end-of-file marker. `exit` is a runtime statement; it cannot outrun
the parser. An archive appended to a `.ps1` is expected to fail, and the suite
checks that expectation rather than assuming it.

## Several names for one archive

| Mechanism | Administrator? | Notes |
|---|---|---|
| `mklink /H` (hard link) | no | files only, same volume — the best fit |
| `mklink` (symbolic link) | yes, unless Developer Mode is on | `SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE` needs it |
| a copy per name | no | works, but N files to sign and audit |
| App Execution Alias | — | packaged apps only; needs package identity |

Whether the *link's* name reaches the program is undocumented on Windows. On
Linux both symlinks and hard links do reach it, which is what makes one archive
able to carry several commands and switch on `basename(process.argv[1])`. It is
true on Windows too — a copy, a hard link and a symbolic link each arrive as
their own name — which the suite now checks on every run.

## Where the tests are

These are not notes any more: they are
[`test/windows.test.ts`](../../../test/windows.test.ts), which runs as part of
`npm test` and skips itself everywhere but Windows — the mirror image of the
launcher tests, which skip *on* Windows. [CI](../../../.github/workflows/ci.yml)
runs the suite on Linux and Windows in parallel, and nothing publishes unless
both pass.

They cover what the documentation could not answer:

- the setup registers `.nzip` and puts `.NZIP` on the user's PATHEXT
- running the setup twice changes nothing
- the association starts an archive, with its arguments
- **typed without the extension**, found through PATHEXT — the case that was
  broken until the probe caught it
- a copy, a hard link and a symbolic link each report their own name, so one
  archive can carry several commands there too
- a `.ps1` with an archive appended does not run

The test writes to the registry, because a file association cannot be tested
without one. It writes under HKCU only, snapshots what was there first, and puts
it back afterwards — including deleting the keys when there was nothing there.

## One more thing the research turned up

On Windows, `npm install -g @pipobscure/bundle` currently produces a command
that cannot run. npm builds its shims with `cmd-shim`, which reads the target's
`#!` line and turns it into an interpreter; ours says `#!/bin/sh`, so the
generated `bundle.cmd` runs `/bin/sh` — as a path on the current drive, with no
PATH lookup and no Git Bash fallback. Running cmd-shim over our real
`bundle.run` here produces exactly that.

Worth knowing before fixing it: cmd-shim's own fixtures show that a target with
**no** shebang gets a `.cmd` that executes the target directly. So an archive
that Windows can start on its own — either of the first two routes above —
would also make npm's shim do the right thing.
