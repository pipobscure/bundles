// Mounting at a place chosen in another thread.
//
// node:vfs gives every file system a mount point of its own when it is
// created — `/dev/null/vfs/<n>`, counting up in each thread — and takes no
// say in it. A worker thread starts counting afresh. So a plugin the main
// thread mounted at `/dev/null/vfs/3` is, in a worker that mounts it too,
// wherever the worker's count happens to be — and every URL the main thread
// handed over (`new URL('./worker.js', import.meta.url)`) points at nothing.
//
// What can be done is to bring the worker's count to the same place before
// mounting: a mount point is taken when a file system is created, so creating
// empty ones until the next is the one wanted puts the plugin where it was.
// That only works upwards — a worker that has already mounted past it cannot
// go back — and says so when it cannot.
//
// No import of node:vfs here: the plugin loader, which needs this, must load
// without --experimental-vfs. Whoever mounts passes the module in.

interface Vfs {
    create(...args: unknown[]): unknown;
}

/** The number at the end of a mount point, or undefined for one that has none. */
export function mountNumber(root: string): number | undefined {
    const match = /(\d+)[\\/]*$/.exec(root);
    return match ? Number(match[1]) : undefined;
}

/**
 * Mount what `make()` creates — with `at`, at that mount point, which must
 * not be behind this thread's count; otherwise this throws, and nothing stays
 * mounted. `make()` may be called twice: the first, when it lands short of
 * `at`, is unmounted again.
 */
export function mountAt(VFS: Vfs, make: () => { mount(): string; unmount(): void }, at?: string | undefined): string {
    if (at === undefined) return make().mount();
    const wanted = mountNumber(at);
    if (wanted === undefined) throw new Error(`cannot mount at ${at}: node:vfs names its mount points differently than this expects`);
    const first = make();
    const root = first.mount();
    if (root === at) return root;
    first.unmount();
    const got = mountNumber(root);
    if (got === undefined || got > wanted) {
        throw Object.assign(new Error(`cannot mount at ${at}: this thread has mounted past it already — start the worker before it mounts anything of its own`),
            { code: 'ERR_BUNDLE_MOUNT_POINT' });
    }
    // Each file system created takes the next mount point, mounted or not.
    for (let n = got + 1; n < wanted; n++) VFS.create({ emitExperimentalWarning: false });
    const second = make();
    const again = second.mount();
    if (again !== at) {
        second.unmount();
        throw Object.assign(new Error(`mounted at ${again}, not at ${at} as asked`), { code: 'ERR_BUNDLE_MOUNT_POINT' });
    }
    return again;
}
