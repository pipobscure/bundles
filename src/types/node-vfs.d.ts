// The parts of `node:vfs` that @types/node's own `vfs.d.ts` does not yet carry:
// provider registration, the ZIP provider, the provider methods a subclass
// overrides, and mounting. Declarations merge with the shipped ones, so only
// the gaps are filled here.
declare module "node:vfs" {
    import type { Stats, PathLike } from "node:fs";
    import type { FileHandle } from "node:fs/promises";
    import type { ZipBuffer, ZipFile } from "node:zlib";

    /**
     * How `--vfs-mount` picks a provider for its source: the first registered
     * provider whose `canHandle()` accepts it wins, ahead of node's built-ins.
     */
    interface ProviderRegistration {
        /** Reported in diagnostics. */
        name: string;
        /** Whether this provider should back `resolvedPath`. */
        canHandle(resolvedPath: string, stats: Stats): boolean;
        /** Build the provider for a source this registration claimed. */
        create(resolvedPath: string): VirtualProvider;
    }

    function registerProvider(registration: ProviderRegistration): void;

    // `VirtualProvider` is declared as a class with no members; this interface
    // merges the fs-like surface a provider implements onto it.
    interface VirtualProvider {
        open(path: string, flags?: string | number, mode?: number): Promise<FileHandle>;
        openSync(path: string, flags?: string | number, mode?: number): number;
        stat(path: string): Promise<Stats>;
        statSync(path: string): Stats;
        lstat(path: string): Promise<Stats>;
        lstatSync(path: string): Stats;
        readdir(path: string): Promise<string[]>;
        readdirSync(path: string): string[];
        mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<string | undefined>;
        mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): string | undefined;
        rmdir(path: string): Promise<void>;
        rmdirSync(path: string): void;
        unlink(path: string): Promise<void>;
        unlinkSync(path: string): void;
        rename(from: string, to: string): Promise<void>;
        renameSync(from: string, to: string): void;
        readFile(path: string, options?: unknown): Promise<Buffer>;
        readFileSync(path: string, options?: unknown): Buffer;
        writeFile(path: string, data: unknown, options?: unknown): Promise<void>;
        writeFileSync(path: string, data: unknown, options?: unknown): void;
        appendFile(path: string, data: unknown, options?: unknown): Promise<void>;
        appendFileSync(path: string, data: unknown, options?: unknown): void;
        exists(path: string): Promise<boolean>;
        existsSync(path: string): boolean;
        copyFile(from: string, to: string, mode?: number): Promise<void>;
        copyFileSync(from: string, to: string, mode?: number): void;
        realpath(path: string): Promise<string>;
        realpathSync(path: string): string;
        access(path: string, mode?: number): Promise<void>;
        accessSync(path: string, mode?: number): void;
        link(existing: string, path: string): Promise<void>;
        linkSync(existing: string, path: string): void;
        readlink(path: string): Promise<string>;
        readlinkSync(path: string): string;
        symlink(target: string, path: string): Promise<void>;
        symlinkSync(target: string, path: string): void;
    }

    interface MemoryProvider extends VirtualProvider {}
    interface RealFSProvider extends VirtualProvider {}

    /** node's built-in ZIP provider — the base the verifying provider extends. */
    class ZipProvider extends VirtualProvider {
        constructor(archive: ZipFile | ZipBuffer);
        close(): Promise<void>;
        closeSync(): void;
    }

    interface VirtualFileSystem {
        /** Mount this VFS, at `path` or at a generated mount point. Returns it. */
        mount(path?: PathLike): string;
        unmount(): void;
        readonly mounted: boolean;
        readonly mountPoint: string | undefined;
        readonly mountPointURL: string | undefined;
    }
}
