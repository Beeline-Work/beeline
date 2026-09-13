#!/usr/bin/env node
// Regenerates apps/mobile/src-tauri/icons from the one source of app identity,
// sources/assets/images/icon.png. Linux and Windows keep that square treatment;
// macOS gets its own Big Sur-style transparent canvas before the .icns is
// encoded. `tauri icon` would do the same reshaping, but it needs the Rust
// toolchain installed; this uses nothing but node's zlib so the desktop icons
// can be refreshed from any checkout.
//
// Outputs the six files tauri.conf.json's bundle.icon names: three PNGs for
// Linux, an .ico for Windows and an .icns for macOS, plus the 1024px master.
//
//   node scripts/generate-tauri-icons.mjs [--check]
//
// --check regenerates into memory and fails if any committed file differs, so
// a changed source icon cannot silently leave the desktop bundles stale.
import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, '..', 'sources', 'assets', 'images', 'icon.png');
const ICONS = join(here, '..', 'src-tauri', 'icons');
const EVIDENCE = join(here, '..', 'evidence', 'macos-app-icon');

const MAC_CANVAS_SIZE = 1024;
const MAC_PLATE_INSET = 100;
const MAC_PLATE_SIZE = 824;
const MAC_CORNER_RADIUS = 185;
const MAC_MARK_WIDTH = 528;
const MARK_THRESHOLD = 8;

const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

const crc32 = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};

// Decodes the 8-bit non-interlaced RGB/RGBA PNGs this repo's icons are; any
// other shape is a mistake worth failing on rather than guessing at.
function decodePng(file) {
    if (file.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
    let offset = 8;
    let header;
    const idat = [];
    while (offset < file.length) {
        const length = file.readUInt32BE(offset);
        const type = file.toString('ascii', offset + 4, offset + 8);
        const data = file.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') {
            header = {
                width: data.readUInt32BE(0),
                height: data.readUInt32BE(4),
                depth: data[8],
                colorType: data[9],
                interlace: data[12],
            };
        } else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        offset += 12 + length;
    }
    if (!header) throw new Error('PNG has no IHDR');
    if (header.depth !== 8 || header.interlace !== 0 || ![2, 6].includes(header.colorType)) {
        throw new Error(
            `unsupported PNG: depth ${header.depth}, colorType ${header.colorType}, interlace ${header.interlace}`,
        );
    }

    const channels = header.colorType === 6 ? 4 : 3;
    const stride = header.width * channels;
    const raw = inflateSync(Buffer.concat(idat));
    const pixels = Buffer.alloc(header.width * header.height * 4);

    let previous = Buffer.alloc(stride);
    for (let y = 0; y < header.height; y += 1) {
        const filter = raw[y * (stride + 1)];
        const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
        for (let x = 0; x < stride; x += 1) {
            const a = x >= channels ? line[x - channels] : 0;
            const b = previous[x];
            const c = x >= channels ? previous[x - channels] : 0;
            let value = line[x];
            if (filter === 1) value += a;
            else if (filter === 2) value += b;
            else if (filter === 3) value += (a + b) >> 1;
            else if (filter === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
            line[x] = value & 0xff;
        }
        for (let x = 0; x < header.width; x += 1) {
            const from = x * channels;
            const to = (y * header.width + x) * 4;
            pixels[to] = line[from];
            pixels[to + 1] = line[from + 1];
            pixels[to + 2] = line[from + 2];
            pixels[to + 3] = channels === 4 ? line[from + 3] : 0xff;
        }
        previous = line;
    }
    return { width: header.width, height: header.height, pixels };
}

// Box filter: every destination pixel averages the whole source rectangle it
// covers, so a 1024px master downsamples without the aliasing a nearest
// neighbour sample leaves on the mark's diagonal.
function resize(image, size) {
    const out = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y += 1) {
        const y0 = Math.floor((y * image.height) / size);
        const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * image.height) / size));
        for (let x = 0; x < size; x += 1) {
            const x0 = Math.floor((x * image.width) / size);
            const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * image.width) / size));
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            let n = 0;
            for (let sy = y0; sy < y1; sy += 1) {
                for (let sx = x0; sx < x1; sx += 1) {
                    const from = (sy * image.width + sx) * 4;
                    r += image.pixels[from];
                    g += image.pixels[from + 1];
                    b += image.pixels[from + 2];
                    a += image.pixels[from + 3];
                    n += 1;
                }
            }
            const to = (y * size + x) * 4;
            out[to] = Math.round(r / n);
            out[to + 1] = Math.round(g / n);
            out[to + 2] = Math.round(b / n);
            out[to + 3] = Math.round(a / n);
        }
    }
    return { width: size, height: size, pixels: out };
}

function markBounds(image) {
    const ground = image.pixels.subarray(0, 3);
    let left = image.width;
    let top = image.height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
            const at = (y * image.width + x) * 4;
            const differs = [0, 1, 2].some(
                (channel) =>
                    Math.abs(image.pixels[at + channel] - ground[channel]) >= MARK_THRESHOLD,
            );
            if (!differs) continue;
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
        }
    }
    if (right < left || bottom < top) throw new Error('source icon has no visible mark');
    return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

function sampleBilinear(image, x, y, channel) {
    const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(x)));
    const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
    const x1 = Math.min(image.width - 1, x0 + 1);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;
    const pixel = (px, py) => image.pixels[(py * image.width + px) * 4 + channel];
    const top = pixel(x0, y0) * (1 - tx) + pixel(x1, y0) * tx;
    const bottom = pixel(x0, y1) * (1 - tx) + pixel(x1, y1) * tx;
    return Math.round(top * (1 - ty) + bottom * ty);
}

function insideRoundedPlate(x, y) {
    const nearX = Math.max(
        MAC_PLATE_INSET + MAC_CORNER_RADIUS,
        Math.min(x, MAC_PLATE_INSET + MAC_PLATE_SIZE - MAC_CORNER_RADIUS),
    );
    const nearY = Math.max(
        MAC_PLATE_INSET + MAC_CORNER_RADIUS,
        Math.min(y, MAC_PLATE_INSET + MAC_PLATE_SIZE - MAC_CORNER_RADIUS),
    );
    return (x - nearX) ** 2 + (y - nearY) ** 2 <= MAC_CORNER_RADIUS ** 2;
}

// Apple's icon grid leaves 100px around the 824px plate. Four-by-four coverage
// sampling keeps the 185px rounded edge clean in the 1024px master; the normal
// box filter then carries that antialiasing into every smaller .icns payload.
function macSource(source) {
    if (source.width !== MAC_CANVAS_SIZE || source.height !== MAC_CANVAS_SIZE) {
        throw new Error(`macOS source must be ${MAC_CANVAS_SIZE}x${MAC_CANVAS_SIZE}`);
    }
    const bounds = markBounds(source);
    const scale = MAC_MARK_WIDTH / bounds.width;
    const markCenterX = (bounds.left + bounds.right) / 2;
    const markCenterY = (bounds.top + bounds.bottom) / 2;
    const canvasCenter = MAC_CANVAS_SIZE / 2;
    const pixels = Buffer.alloc(MAC_CANVAS_SIZE * MAC_CANVAS_SIZE * 4);

    for (let y = MAC_PLATE_INSET; y < MAC_PLATE_INSET + MAC_PLATE_SIZE; y += 1) {
        for (let x = MAC_PLATE_INSET; x < MAC_PLATE_INSET + MAC_PLATE_SIZE; x += 1) {
            let covered = 0;
            for (let sy = 0; sy < 4; sy += 1) {
                for (let sx = 0; sx < 4; sx += 1) {
                    if (insideRoundedPlate(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) covered += 1;
                }
            }
            if (covered === 0) continue;

            const sourceX = (x + 0.5 - canvasCenter) / scale + markCenterX - 0.5;
            const sourceY = (y + 0.5 - canvasCenter) / scale + markCenterY - 0.5;
            const to = (y * MAC_CANVAS_SIZE + x) * 4;
            for (let channel = 0; channel < 3; channel += 1) {
                pixels[to + channel] = sampleBilinear(source, sourceX, sourceY, channel);
            }
            pixels[to + 3] = Math.round((covered / 16) * 255);
        }
    }
    return { width: MAC_CANVAS_SIZE, height: MAC_CANVAS_SIZE, pixels };
}

function encodePng(image) {
    const stride = image.width * 4;
    const raw = Buffer.alloc((stride + 1) * image.height);
    for (let y = 0; y < image.height; y += 1) {
        raw[y * (stride + 1)] = 0;
        image.pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }

    const chunk = (type, data) => {
        const out = Buffer.alloc(12 + data.length);
        out.writeUInt32BE(data.length, 0);
        out.write(type, 4, 'ascii');
        data.copy(out, 8);
        out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
        return out;
    };

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(image.width, 0);
    ihdr.writeUInt32BE(image.height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// 32-bit BGRA DIB with the empty AND mask an ICO entry still requires. Used
// for the small entries: Windows renders PNG-in-ICO only from Vista on, and
// the 16/32/48px entries are exactly the ones legacy shell surfaces read.
function encodeDib(image) {
    const maskStride = Math.ceil(image.width / 32) * 4;
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(image.width, 4);
    header.writeInt32LE(image.height * 2, 8);
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    header.writeUInt32LE(image.width * image.height * 4 + maskStride * image.height, 20);

    const body = Buffer.alloc(image.width * image.height * 4);
    for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
            const from = ((image.height - 1 - y) * image.width + x) * 4;
            const to = (y * image.width + x) * 4;
            body[to] = image.pixels[from + 2];
            body[to + 1] = image.pixels[from + 1];
            body[to + 2] = image.pixels[from];
            body[to + 3] = image.pixels[from + 3];
        }
    }
    return Buffer.concat([header, body, Buffer.alloc(maskStride * image.height)]);
}

function encodeIco(entries) {
    const directory = Buffer.alloc(6 + entries.length * 16);
    directory.writeUInt16LE(0, 0);
    directory.writeUInt16LE(1, 2);
    directory.writeUInt16LE(entries.length, 4);

    let offset = directory.length;
    entries.forEach(({ size, data }, index) => {
        const at = 6 + index * 16;
        directory[at] = size === 256 ? 0 : size;
        directory[at + 1] = size === 256 ? 0 : size;
        directory.writeUInt16LE(1, at + 4);
        directory.writeUInt16LE(32, at + 6);
        directory.writeUInt32LE(data.length, at + 8);
        directory.writeUInt32LE(offset, at + 12);
        offset += data.length;
    });
    return Buffer.concat([directory, ...entries.map((entry) => entry.data)]);
}

// PNG-payload icns types. ic07..ic10 are the 128/256/512/1024 points, ic11..
// ic14 the @2x retina variants macOS looks up for 16/32/128/256pt slots.
const ICNS_TYPES = [
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32],
    ['ic12', 64],
    ['ic13', 256],
    ['ic14', 512],
];

function encodeIcns(pngFor) {
    const entries = ICNS_TYPES.map(([type, size]) => {
        const payload = pngFor(size);
        const entry = Buffer.alloc(8 + payload.length);
        entry.write(type, 0, 'ascii');
        entry.writeUInt32BE(entry.length, 4);
        payload.copy(entry, 8);
        return entry;
    });
    const total = 8 + entries.reduce((sum, entry) => sum + entry.length, 0);
    const header = Buffer.alloc(8);
    header.write('icns', 0, 'ascii');
    header.writeUInt32BE(total, 4);
    return Buffer.concat([header, ...entries]);
}

const source = decodePng(readFileSync(SOURCE));
const mac = macSource(source);
const scaled = new Map();
const at = (size) => {
    if (!scaled.has(size)) scaled.set(size, size === source.width ? source : resize(source, size));
    return scaled.get(size);
};
const pngCache = new Map();
const pngAt = (size) => {
    if (!pngCache.has(size)) pngCache.set(size, encodePng(at(size)));
    return pngCache.get(size);
};
const macScaled = new Map();
const macPngCache = new Map();
const macAt = (size) => {
    if (!macScaled.has(size)) macScaled.set(size, size === mac.width ? mac : resize(mac, size));
    return macScaled.get(size);
};
const macPngAt = (size) => {
    if (!macPngCache.has(size)) macPngCache.set(size, encodePng(macAt(size)));
    return macPngCache.get(size);
};

const outputs = new Map([
    ['32x32.png', pngAt(32)],
    ['128x128.png', pngAt(128)],
    ['128x128@2x.png', pngAt(256)],
    ['icon.png', pngAt(1024)],
    [
        'icon.ico',
        encodeIco([
            { size: 16, data: encodeDib(at(16)) },
            { size: 32, data: encodeDib(at(32)) },
            { size: 48, data: encodeDib(at(48)) },
            { size: 64, data: pngAt(64) },
            { size: 128, data: pngAt(128) },
            { size: 256, data: pngAt(256) },
        ]),
    ],
    ['icon.icns', encodeIcns(macPngAt)],
]);

const evidence = new Map([
    ['reproduced-square-128.png', pngAt(128)],
    ['demonstrated-rounded-1024.png', macPngAt(1024)],
    ['demonstrated-rounded-128.png', macPngAt(128)],
]);

const check = process.argv.includes('--check');
const stale = [];
for (const [name, data] of outputs) {
    const path = join(ICONS, name);
    if (check) {
        let existing;
        try {
            existing = readFileSync(path);
        } catch {
            stale.push(`${name} (missing)`);
            continue;
        }
        if (!existing.equals(data)) stale.push(name);
    } else {
        writeFileSync(path, data);
    }
}
for (const [name, data] of evidence) {
    const path = join(EVIDENCE, name);
    if (check) {
        let existing;
        try {
            existing = readFileSync(path);
        } catch {
            stale.push(`evidence/${name} (missing)`);
            continue;
        }
        if (!existing.equals(data)) stale.push(`evidence/${name}`);
    } else {
        writeFileSync(path, data);
    }
}

if (check) {
    if (stale.length > 0) {
        console.error(
            `Desktop icons no longer match ${SOURCE.replace(/.*apps\//, 'apps/')}:\n  ${stale.join('\n  ')}`,
        );
        console.error('Run: node scripts/generate-tauri-icons.mjs');
        process.exit(1);
    }
    console.log(
        `Desktop icons: ${outputs.size} bundle file(s) and ${evidence.size} evidence file(s) match the source icon.`,
    );
} else {
    console.log(`Desktop icons written to src-tauri/icons: ${[...outputs.keys()].join(', ')}`);
}
