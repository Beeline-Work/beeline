// Reproduction (TOOL-DOC-1): docs/tool-reference.md listed internal action names (list_files, git_*,
// pr_checks_status, watch, create_schedule, save_memory, search_history, ...) as tools and named 7 of the 30 tools
// agents are advertised. Every tool in its tables must be advertised, and every advertised tool must be listed.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RUNNER_TOOL, SILENT_TOOL, minimalTools, repositoryTools, scratchTools } from './minimal-tool-surface.js';

const doc = readFileSync(new URL('../../../docs/tool-reference.md', import.meta.url), 'utf8');
const documented = [...new Set(doc.split('\n').filter(line => line.startsWith('| `'))
  .flatMap(line => [...line.split('|')[1]!.matchAll(/`([a-z_]+)`/g)].map(match => match[1]!)))].sort();
const advertised = [...new Set([...minimalTools(true), ...minimalTools(false), RUNNER_TOOL, SILENT_TOOL, ...scratchTools(true), ...repositoryTools()]
  .map(tool => tool.name))].sort();

describe('TOOL-DOC-1: docs/tool-reference.md names the advertised tools', () => {
  it('lists only advertised tools (plus the CodeGraph server tool)', () => {
    expect(documented.filter(name => !advertised.includes(name) && name !== 'codegraph_explore')).toEqual([]);
  });
  it('lists every advertised tool', () => {
    expect(advertised.filter(name => !documented.includes(name))).toEqual([]);
  });
});
