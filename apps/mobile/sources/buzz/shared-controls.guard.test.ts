import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error The source inventory is also executable from Node without compilation.
import { scanSharedControls } from '../../scripts/shared-control-audit.mjs';
import exceptions from '../../design/shared-control-allowlist.json';

it('keeps every raw labelled control and dialog-action exception individually justified', () => {
  const hits = scanSharedControls(path.resolve('sources')) as {
    id: string;
    file: string;
    rule: string;
  }[];
  const approved = new Map(exceptions.map((item) => [item.id, item]));
  expect(hits.filter((hit) => !approved.has(hit.id))).toEqual([]);
  expect(exceptions.filter((item) => !hits.some((hit) => hit.id === item.id))).toEqual([]);
  for (const item of exceptions) expect(item.reason.length).toBeGreaterThan(30);
});

it('rejects new bespoke text buttons, retry boxes and dialog actions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beeline-controls-'));
  try {
    fs.writeFileSync(
      path.join(root, 'NewControl.tsx'),
      `<><Pressable><Text>Retry</Text></Pressable><View style={styles.error}><Text>Failed</Text><Button label="Reconnect" /></View><HullDialogActions actions={[]} /></>`,
    );
    const hits = scanSharedControls(root) as { rule: string }[];
    expect(hits.map((hit) => hit.rule).sort()).toEqual(['6a', '6b', '6c']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
