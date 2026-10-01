import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalizeAvatarPng } from './avatar-png';

const imagePicker = vi.hoisted(() => ({
  requestMediaLibraryPermissionsAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(async () => ({ canceled: true, assets: null })),
}));

vi.mock('expo-image-picker', () => imagePicker);
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: vi.fn(), SaveFormat: { PNG: 'png' } }));
vi.mock('@/utils/readFileBytes', () => ({ readFileBytes: vi.fn() }));

const signature = [137, 80, 78, 71, 13, 10, 26, 10];

function chunk(name: string, data: number[] = []): number[] {
  const length = data.length;
  return [
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    ...[...name].map((character) => character.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0,
  ];
}

function names(bytes: Uint8Array): string[] {
  const found: string[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const length =
      bytes[offset]! * 0x1000000 +
      bytes[offset + 1]! * 0x10000 +
      bytes[offset + 2]! * 0x100 +
      bytes[offset + 3]!;
    const name = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    found.push(name);
    offset += length + 12;
  }
  return found;
}

describe('avatar PNG normalization', () => {
  it('drops metadata channels while preserving the lossless image chunks', () => {
    const source = new Uint8Array([
      ...signature,
      ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
      ...chunk('cHRM', [1, 2, 3]),
      ...chunk('tEXt', [4, 5, 6]),
      ...chunk('IDAT', [7, 8, 9]),
      ...chunk('IEND'),
    ]);

    const normalized = canonicalizeAvatarPng(source);

    expect(names(normalized)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(normalized.byteLength).toBeLessThan(source.byteLength);
  });

  it('rejects incomplete containers before the relay request', () => {
    expect(() => canonicalizeAvatarPng(new Uint8Array(signature))).toThrow('incomplete PNG');
  });
});

describe('photo picker permission', () => {
  it('opens the system picker without asking for photo library access', async () => {
    const { pickAndUploadAvatar } = await import('./avatar-upload');

    await expect(pickAndUploadAvatar({} as never)).resolves.toBeNull();

    expect(imagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);
    expect(imagePicker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
  });

  it('keeps library and camera permission requests out of the app sources', () => {
    const root = join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const text = readFileSync(path, 'utf8');
          if (/request(MediaLibrary|Camera)PermissionsAsync/.test(text)) offenders.push(path);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
