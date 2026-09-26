import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  computeInstitutionalMemoryShadowMetrics,
  type InstitutionalMemoryAuditRecord,
} from './institutional-memory-evaluation.js';

const input = resolve(
  process.argv[2] ?? 'src/fixtures/institutional-memory-shadow-evaluation.json',
);
const parsed = JSON.parse(await readFile(input, 'utf8')) as unknown;
if (!Array.isArray(parsed)) throw new Error('institutional memory audit input must be an array');
console.log(
  JSON.stringify(
    computeInstitutionalMemoryShadowMetrics(parsed as InstitutionalMemoryAuditRecord[]),
    null,
    2,
  ),
);
