import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(__dirname, '../..');

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(absolute);
    if (!/\.tsx?$/.test(entry.name) || /\.(?:test|spec)\.tsx?$/.test(entry.name)) return [];
    return [absolute];
  });
}

describe('native dialog enforcement', () => {
  it('forbids app-owned system alerts, action sheets, and Expo native menu chrome', () => {
    const violations = productionSources(sourceRoot).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [
        /import\s*\{[^}]*\bAlert(?:\s+as\s+\w+)?\b[^}]*\}\s*from\s*['"]react-native['"]/,
        /\bAlert\.(?:alert|prompt)\b/,
        /\bActionSheetIOS\b/,
        /\bshowActionSheetWithOptions\b/,
        /@expo\/ui\/(?:swift-ui|jetpack-compose)/,
      ]
        .filter((pattern) => pattern.test(source))
        .map((pattern) => ({
          file: path.relative(sourceRoot, file),
          pattern: pattern.source,
        }));
    });
    expect(violations).toEqual([]);
  });

  it('keeps React Native Modal ownership at the single Hull boundary', () => {
    const owners = productionSources(sourceRoot)
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]react-native['"];?/g)].some(
          ([, imports]) => /\bModal\b/.test(imports),
        );
      })
      .map((file) => path.relative(sourceRoot, file));

    expect(owners).toEqual(['components/buzz/HullDialog.tsx']);
  });

  it('keeps New Room in the Hull input family without a conditional helper label', () => {
    const channels = readFileSync(path.join(sourceRoot, 'app/(app)/beeline/channels.tsx'), 'utf8');
    const testId = channels.indexOf('testID="new-room-dialog"');
    const start = channels.lastIndexOf('<HullDialog', testId);
    const end = channels.indexOf('</HullDialog>', start);
    const newRoom = channels.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(newRoom).toContain('title={`New ${ROOM_LABEL}`}');
    expect(newRoom).toContain('<HullDialogInput');
    expect(newRoom).not.toMatch(/helper|fieldnote|conditional/i);
  });
});
