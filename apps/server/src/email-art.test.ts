import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('keeps every email animal, contrast edge, palette algorithm and logo identical to the mobile source',()=>{
  expect(()=>execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/generate-email-art.mjs',import.meta.url)),'--check'])).not.toThrow();
});
