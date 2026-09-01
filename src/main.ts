#!/usr/bin/env node
import { main } from './cli.ts';

// The executable entry point, in every launch mode this tool has:
//
//   * `bundle …` / `node dist/main.js …` — an ordinary CLI.
//   * `--vfs-load --vfs-mount <archive>` — node runs the mounted package's
//     `main`, which is this file, out of the archive.
//   * the SEA container, whose bootstrap mounts its own tail and then requires
//     the package inside it, landing here.
//
// In all three, `process.argv` is [runtime, entry, ...userArgs], so the user's
// arguments always start at index 2.
//
// Nothing but argv handling lives here. `cli.ts` returns an exit code rather
// than exiting, so it stays callable in-process — by a test, or by a host that
// wants the commands without a subprocess — and the one place that turns a code
// into an exit is this file.

process.exitCode = await main(process.argv.slice(2));
