import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '_chat-surface.tsx'), 'utf8');

describe('preview agent-command autocomplete wiring', () => {
  it('loads the addressed agent command snapshot and hands it to the preview menu', () => {
    expect(source).toContain('.agent(activeCommunityId, pubkey)');
    expect(source).toContain('[scope]: detail.commands ?? []');
    expect(source).toContain('commands={mentionAgentCommands}');
    expect(source).toContain('onSelectCommand={insertAgentCommand}');
  });
});
