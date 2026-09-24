// The smallest useful bundled application: it prints its own argv and exits.
//
// It exists to answer "did my arguments survive?", which is the question every
// launcher shape raises. A bundle can be run four ways, and each one hands the
// program its arguments through a different path:
//
//   node --experimental-vfs --vfs-load=. -- a b   from source, mounted
//   ./echo-argv.run a b                           the shell launcher prefix
//   bundle run echo-argv.run -- a b               through the verifying mount
//   node --experimental-vfs --vfs-load=echo-argv.run -- a b
//
// All four should print the same three lines below, with `argv[1]` naming the
// source this program was loaded from rather than the mount point — which is
// what lets a signed archive read its own bytes.

const [runtime, source, ...args] = process.argv;

console.log(`runtime: ${runtime}`);
console.log(`source:  ${source}`);
console.log(`args:    ${JSON.stringify(args)}`);
