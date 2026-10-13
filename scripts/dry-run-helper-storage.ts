#!/usr/bin/env node
import { resolve } from 'node:path';
import { helperStorageReport } from '../apps/body/src/storage-report.js';
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--agents-root'))
  throw new Error('Usage: npm run dry-run:helper-storage -- [--agents-root <path>] (read-only)');
void helperStorageReport(args[1] ? resolve(args[1], '../..') : undefined).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error instanceof Error ? error.message : 'report failed'); process.exitCode = 1; });
