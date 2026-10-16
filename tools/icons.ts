#!/usr/bin/env node
import * as FS from 'node:fs';
import * as OS from 'node:os';
import * as PATH from 'node:path';
import { spawnSync } from 'node:child_process';
import { packageRoot } from '../src/files.ts';

// The icon `.nzip` files get, in the containers each desktop wants.
//
// There is one drawing, `icons/bundle.svg` — a tree, the project's 🌳, drawn
// for this project rather than taken from an emoji font, so it can ship under
// the package's own licence. Linux uses it as it is: a freedesktop icon theme
// takes SVG. Windows wants an `.ico` and macOS an `.icns`, and both are only
// envelopes around PNGs, so this renders the drawing at each size they ask for
// and writes the envelopes itself.
//
//   node --no-warnings tools/icons.ts      (npm run icons)
//
// Needs `rsvg-convert` (librsvg) on PATH, and only here: the outputs are
// checked in, so neither a build nor an install ever renders anything.

const ROOT = packageRoot();
const ICONS = PATH.join(ROOT, 'icons');
const SOURCE = PATH.join(ICONS, 'bundle.svg');

/** The sizes in the `.ico`: what Explorer picks from, at every view and DPI. */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;

/**
 * The chunks in the `.icns`, and the pixel size each one holds. The `@2x`
 * types carry twice the pixels for the same nominal size, which is how a
 * Retina display gets a sharp 16-point icon.
 */
export const ICNS_TYPES = [
    ['icp4', 16],
    ['icp5', 32],
    ['ic11', 32], // 16@2x
    ['icp6', 64],
    ['ic12', 64], // 32@2x
    ['ic07', 128],
    ['ic08', 256],
    ['ic13', 256], // 128@2x
    ['ic09', 512],
    ['ic14', 512], // 256@2x
    ['ic10', 1024], // 512@2x
] as const;

/**
 * An `.ico` holding these PNGs. The format is a six-byte header, a sixteen-byte
 * directory entry per image, then the images; since Vista an image may simply
 * be a PNG file, which is what every entry here is. All little-endian. A width
 * or height of 256 is written as 0, because the field is one byte.
 */
export function ico(images: Buffer[]): Buffer {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); // reserved
    header.writeUInt16LE(1, 2); // 1 = icon (2 would be a cursor)
    header.writeUInt16LE(images.length, 4);

    const entries: Buffer[] = [];
    let offset = header.length + 16 * images.length;
    for (const png of images) {
        const { width, height } = pngSize(png);
        if (width > 256 || height > 256) throw new Error(`an .ico image is at most 256 pixels square, not ${width}x${height}`);
        const entry = Buffer.alloc(16);
        entry.writeUInt8(width === 256 ? 0 : width, 0);
        entry.writeUInt8(height === 256 ? 0 : height, 1);
        entry.writeUInt8(0, 2); // no palette
        entry.writeUInt8(0, 3); // reserved
        entry.writeUInt16LE(1, 4); // colour planes
        entry.writeUInt16LE(32, 6); // bits per pixel
        entry.writeUInt32LE(png.length, 8);
        entry.writeUInt32LE(offset, 12);
        entries.push(entry);
        offset += png.length;
    }
    return Buffer.concat([header, ...entries, ...images]);
}

/**
 * An `.icns` holding these chunks. The format is the magic `icns` and the
 * whole file's length, then for each chunk its four-character type, its length
 * including those eight bytes, and its data — here always a PNG. All big-endian.
 */
export function icns(chunks: [type: string, png: Buffer][]): Buffer {
    const parts = chunks.map(([type, png]) => {
        if (!/^[ -~]{4}$/.test(type)) throw new Error(`'${type}' is not a four-character icns type`);
        const head = Buffer.alloc(8);
        head.write(type, 0, 'latin1');
        head.writeUInt32BE(png.length + 8, 4);
        return Buffer.concat([head, png]);
    });
    const header = Buffer.alloc(8);
    header.write('icns', 0, 'latin1');
    header.writeUInt32BE(8 + parts.reduce((sum, part) => sum + part.length, 0), 4);
    return Buffer.concat([header, ...parts]);
}

/** A PNG's dimensions, out of its IHDR chunk — which the format puts first. */
export function pngSize(png: Buffer): { width: number; height: number } {
    const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (png.length < 24 || !png.subarray(0, 8).equals(SIGNATURE) || png.toString('latin1', 12, 16) !== 'IHDR') {
        throw new Error('not a PNG');
    }
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// The drawing at `size` pixels square, as PNG bytes.
function render(size: number, scratch: string): Buffer {
    const output = PATH.join(scratch, `${size}.png`);
    const res = spawnSync('rsvg-convert', ['--width', String(size), '--height', String(size), '--output', output, SOURCE], { encoding: 'utf-8' });
    if (res.error) fail(`could not run rsvg-convert (${res.error.message}) — it comes with librsvg`);
    if (res.status !== 0) fail(`rsvg-convert failed at ${size}px: ${res.stderr.trim()}`);
    const png = FS.readFileSync(output);
    const { width, height } = pngSize(png);
    if (width !== size || height !== size) fail(`rsvg-convert made ${width}x${height} when asked for ${size}x${size}`);
    return png;
}

function fail(reason: string): never {
    console.error(`error: ${reason}`);
    process.exit(1);
}

if (import.meta.main) {
    const scratch = FS.mkdtempSync(PATH.join(OS.tmpdir(), 'bundle-icons-'));
    try {
        // Each size once, however many chunks want it.
        const sizes = [...new Set<number>([...ICO_SIZES, ...ICNS_TYPES.map(([, size]) => size)])];
        const pngs = new Map(sizes.map((size) => [size, render(size, scratch)]));

        const outputs: [string, Buffer][] = [
            ['nzip.ico', ico(ICO_SIZES.map((size) => pngs.get(size)!))],
            ['nzip.icns', icns(ICNS_TYPES.map(([type, size]) => [type, pngs.get(size)!]))],
        ];
        for (const [name, bytes] of outputs) {
            FS.writeFileSync(PATH.join(ICONS, name), bytes);
            console.error(`* wrote ${PATH.relative(ROOT, PATH.join(ICONS, name))} (${Math.round(bytes.length / 1024)} KiB)`);
        }
    } finally {
        FS.rmSync(scratch, { recursive: true, force: true });
    }
}
