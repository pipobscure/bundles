# Running a bundle on Windows

Everything this package does on Unix rests on a two-line `#!/bin/sh` prefix:
the kernel hands the file to `sh`, `sh` hands it to node as `--vfs-load="$0"`,
and `$0` is the path the file was *invoked* as — so a symlink gives the program
its own name back. Windows has no `#!`, so the question is what replaces it.

There are three candidates, and they are not equally good.

## 1. A `.cmd` prefix — the direct translation

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

**What is unverified is the part only Windows can answer:** whether cmd.exe
stops reading at `exit /b`, or at the Ctrl-Z, rather than carrying on into the
ZIP and trying to execute it. Microsoft publishes no specification of batch
parsing; 0x1A is documented as an end-of-file marker for `copy` in ASCII mode
and nowhere else. The technique is old and widely used, which is evidence but
not proof. One rule follows from what *is* documented: a prefix may use only
`exit /b` or `goto :EOF`, never `goto :label`, because a label search reads the
whole file looking for it.

## 2. A file association — the one that scales

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
the parser. An archive appended to a `.ps1` is expected to fail, and the probe
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
able to carry several commands and switch on `basename(process.argv[1])`. The
probe settles it for Windows.

## The probe

[`probe.cmd`](probe.cmd) builds two archives out of
[`../index.ts`](../index.ts) — one behind a batch prefix, one bare — and runs
nine checks against them:

1. the batch prefix runs, and cmd.exe stops before the archive
2. a copy reports its own name
3. a hard link reports the link name
4. a symbolic link reports the link name
5. `PATH` + PATHEXT finds it without typing `.cmd`
6. a `.nzip` association runs the archive
7. PATHEXT finds `app.nzip` when you type `app`
8. a second (hard-linked) name for one `.nzip` reports itself
9. a `.ps1` with an archive appended does not run — a PASS here would be a surprise

and three more over what `bundle install` sets up, since that is the code a user
actually meets:

- **9a–9c** — it associates `.nzip` with `NodeBundle`, and adds `.NZIP` to the
  *user's* `PATHEXT` as `REG_EXPAND_SZ`. Not `setx`: that would write back the
  merged machine+user value and mask later system-wide changes, and it truncates
  past 1024 characters. What `setx` does do is broadcast `WM_SETTINGCHANGE`, so
  `install` sends that itself — through `node:ffi` and `SendMessageTimeoutW`,
  with `SMTO_ABORTIFHUNG` and a two-second timeout so one hung window cannot
  hang an install.
- **9d** — running it again changes nothing, because both halves are checked
  before they are written.

The probe restores the user's `PATHEXT` and removes the keys it added.

```bat
cd examples\echo-argv\windows
probe.cmd
```

It needs node 26.10 or later on `PATH` and a built checkout (`npm run build`).
It runs unelevated: the association goes into HKCU, which needs no rights and
is removed afterwards, and the one check that would need elevation (the
symbolic link) skips itself instead. Everything else is written to `%TEMP%`.

The archives it builds are deliberately **unsigned**: what is under test is how
Windows *starts* a file, and a signature adds nothing to that. Signing works
the same on Windows as anywhere else — the bytes are the bytes.

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
