import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '_chat-surface.tsx'), 'utf8');

describe('preview agent-command autocomplete wiring', () => {
  it('loads the addressed agent command snapshot and hands it to the preview menu', () => {
    expect(source).toContain('.agent(activeCommunityId, pubkey)');
    expect(source).toContain('[scope]: detail.commands ?? []');
    expect(source).toContain('commands={mentionAgentCommands}');
    expect(source).toContain('onSelectCommand={selectAgentCommand}');
    // Beeline's Room verbs narrow with the same typed `@agent /query`.
    expect(source).toContain("currentSlashQuery ?? mentionSlash?.query ?? ''");
  });

  it('offers the owner Fast mode from the same agent read and toggles it through the profile operation', () => {
    expect(source).toContain('[scope]: fastModeCommandState(detail, viewerPubkey)');
    expect(source).toContain('agentFastModeByScope[mentionAgentCommandScope]');
    expect(source).toContain(
      'client.setAgentModelConfig(activeCommunityId, pubkey, { fastMode: enabled })',
    );
    expect(source).toMatch(/name === FAST_MODE_COMMAND\)\s*{\s*void toggleAgentFastMode\(\);/);
  });
});
