import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
// @ts-expect-error Executable source inventory.
import { scanErrorSurfaces, scanErrorPlaceholders } from '../../scripts/error-surface-audit.mjs';
import exceptions from '../../design/error-surface-allowlist.json';

it('requires an individually documented inset for every contextual error', () => {
  const hits = scanErrorSurfaces(path.resolve('sources')) as { file: string; tag: string; source: string }[];
  expect(hits.map(({ file, tag, source, ancestors, layoutHash }: any) => ({ file, tag, source, ancestors, layoutHash }))).toEqual(exceptions.map(({ file, tag, source, ancestors, layoutHash }) => ({ file, tag, source, ancestors, layoutHash })));
  for (const item of exceptions) expect(item.reason.length).toBeGreaterThan(30);
});
it('keeps page failures in standard rows with one trailing retry word', () => {
  for (const file of ['app/(app)/beeline/channels.tsx', 'app/(app)/beeline/members.tsx', 'app/(app)/beeline/corners/[roomId].tsx', 'app/(app)/beeline/workflow.tsx', 'app/(app)/beeline/workflow-run.tsx', 'components/SidebarView.tsx', 'components/DesktopRoomInspector.tsx']) {
    const source = fs.readFileSync(path.resolve('sources', file), 'utf8');
    expect(source).not.toContain('<ErrorBanner');
    // These states are formatted at their catch or observed-resource boundary.
    expect(source).not.toMatch(/title=\{appErrorCopy\(/);
    expect(source).not.toMatch(/<Button[^>]*label="Retry"/);
    expect(source).toMatch(/<(?:SettingsRow|IndexRow)[^>]*action="Retry"/);
  }
});
it('rejects raw exception serialization in user error setters', () => {
  function visit(dir: string) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) visit(file);
      else if (/\.tsx?$/.test(file) && !/\.(test|spec)\./.test(file)) {
        const source = fs.readFileSync(file, 'utf8');
        expect(source.match(/set\w*Error\([^;]*?(?:String\((?:error|reason|err|caught|cause)\)|(?:error|reason|err|caught|cause)\.name)/g), file).toBeNull();
      }
    }
  }
  visit(path.resolve('sources'));
  // Observed resources publish error state directly rather than through a setter.
  const observer = fs.readFileSync(path.resolve('sources/buzz/use-observed-resource.ts'), 'utf8');
  expect(observer).not.toMatch(/String\(cause(?: instanceof Error)?/);
});

it('discovers newly added flush text and boxed banners instead of silently grandfathering them', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeline-errors-'));
  try {
    fs.writeFileSync(path.join(directory, 'Failure.tsx'), '<View><Text>{error}</Text><ErrorBanner title={error} /></View>');
    expect(scanErrorSurfaces(directory).map((hit: { tag: string }) => hit.tag)).toEqual(['Text', 'ErrorBanner']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
it('never puts a boxed retry button or boxed banner back into a failure surface', () => {
  function visit(directory: string) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) visit(file);
      else if (/\.tsx$/.test(file) && !/\.(test|spec)\./.test(file)) {
        const text = fs.readFileSync(file, 'utf8');
        for (const button of text.matchAll(/<Button\b[^>]*label="Retry"[^>]*\/>/g)) expect(button[0], file).toContain('size="inline"');
        for (const banner of text.matchAll(/<ErrorBanner\b[^>]*\/>/g)) expect(banner[0], file).toMatch(/\binline\b/);
      }
    }
  }
  visit(path.resolve('sources'));
});

it('rejects literal error placeholders throughout app source', () => {
  expect(scanErrorPlaceholders(path.resolve('sources'))).toEqual([]);
});
it('recognizes quoted and encoded placeholders while allowing real interpolation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beeline-error-copy-'));
  try {
    fs.writeFileSync(path.join(directory, 'Placeholders.tsx'), [
      '<SettingsRow title="! {error}" />;',
      "setError('Could not {reason.message}');",
      '<Text>{"${loadError}"}</Text>;',
      '<SettingsRow title="&#123;cause&#125;" />;',
      '<SettingsRow title="{errorMessage}" />;',
      '<SettingsRow title="{lastError.message}" />;',
      'const broken = `Failure: {exception}`;',
      'const valid = `Could not ${error}`;',
      '<SettingsRow title={error} />;',
    ].join('\n'));
    expect(scanErrorPlaceholders(directory).map((hit: {value:string}) => hit.value)).toEqual([
      '! {error}', 'Could not {reason.message}', '${loadError}', '{cause}', '{errorMessage}', '{lastError.message}', 'Failure: {exception}',
    ]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
