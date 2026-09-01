// The ZIP half of `node:zlib` (Node >= 26) that @types/node does not yet carry.
// Only what this package uses is declared; the shapes were checked against the
// running runtime rather than transcribed from documentation.
declare module "node:zlib" {
    import type { Readable } from "node:stream";

    type ZipSource = Buffer | NodeJS.TypedArray | DataView | ArrayBuffer;

    interface ZipEntryCreateOptions {
        comment?: string | undefined;
        mode?: number | undefined;
        modified?: Date | undefined;
        method?: "deflate" | "store" | "zstd" | undefined;
    }

    interface ZipArchiveOptions {
        comment?: string | undefined;
        /** Seeds the archive's absolute offsets, for appending after a prefix. */
        baseOffset?: number | undefined;
    }

    /**
     * One member of an archive. Instances come either from `ZipEntry.create()`
     * (about to be written) or from reading an archive (already written), and
     * carry the same surface either way.
     */
    class ZipEntry {
        readonly name: string;
        readonly nameBuffer: Buffer;
        /** The member's ZIP entry comment; this package stores a content digest here. */
        readonly comment: string;
        readonly size: number;
        readonly compressedSize: number;
        readonly crc32: number;
        readonly method: number;
        readonly flags: number;
        readonly compressed: boolean;
        readonly modified: Date;
        readonly mode: number;
        readonly isSymlink: boolean;
        readonly isFile: boolean;
        readonly isDirectory: boolean;
        content(): Promise<Buffer>;
        contentSync(): Buffer;
        contentIterator(): AsyncIterableIterator<Buffer>;
        static create(filename: string, data: ZipSource, options?: ZipEntryCreateOptions): Promise<ZipEntry>;
        static createSync(filename: string, data: ZipSource, options?: ZipEntryCreateOptions): ZipEntry;
        static createStream(filename: string, data: Readable, options?: ZipEntryCreateOptions): ZipEntry;
        static createSymlink(filename: string, target: string, options?: ZipEntryCreateOptions): ZipEntry;
    }

    /** An archive read from a file descriptor; members are decompressed lazily. */
    class ZipFile {
        static open(path: string): Promise<ZipFile>;
        static openSync(path: string): ZipFile;
        readonly writable: boolean;
        readonly comment: string;
        readonly size: number;
        has(name: string): boolean;
        get(name: string): Promise<ZipEntry>;
        getSync(name: string): ZipEntry;
        keys(): IterableIterator<string>;
        valuesSync(): IterableIterator<ZipEntry>;
        entriesSync(): IterableIterator<[string, ZipEntry]>;
        close(): Promise<void>;
        closeSync(): void;
    }

    /** An archive already wholly in memory. Note: its accessors are synchronous. */
    class ZipBuffer {
        constructor(buffer: ZipSource);
        readonly writable: boolean;
        readonly comment: string;
        readonly size: number;
        has(name: string): boolean;
        get(name: string): ZipEntry;
        keys(): IterableIterator<string>;
        values(): IterableIterator<ZipEntry>;
        entries(): IterableIterator<[string, ZipEntry]>;
        toBufferSync(): Buffer;
    }

    function createZipArchive(entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>, options?: ZipArchiveOptions): Readable;
    function createZipArchiveSync(entries: Iterable<ZipEntry>, options?: ZipArchiveOptions): IterableIterator<Buffer>;
}
