import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Source assertions for the New Room deck's repository picker install flow,
 * in the same style as `roomRepo.design.test.ts`: the deck screen has no
 * render harness, so the structural guarantees are checked as text.
 */
const deckSource = readFileSync(new URL('./channels.tsx', import.meta.url), 'utf8');

function blockFrom(source: string, marker: string, label: string): string {
  const start = source.indexOf(marker);
  expect(start, `missing ${label}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  const braceStart = source.indexOf('{', start);
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed ${label}`);
}

describe('New Room repo picker install flow', () => {
  it('runs the state-bound GitHub install session from the deck', () => {
    const addAccount = blockFrom(
      deckSource,
      'const handleAddGitHubAccount = useCallback',
      'handleAddGitHubAccount',
    );
    expect(addAccount).toContain("returnPath: '/beeline/channels'");
    expect(addAccount).toContain(
      'transport.githubInstallationStart(githubInstallationRedirectUri())',
    );
    expect(addAccount).toContain('refreshRepositories: () => loadRepoPicker(true)');
    // The install session reports its phases through the picker's notice line.
    expect(addAccount).toContain('onRefreshPhase: handleRepositoryRefreshPhase');
  });

  it('manages an existing installation through the same session', () => {
    const manage = blockFrom(
      deckSource,
      'const handleManageGitHubInstallation = useCallback',
      'handleManageGitHubInstallation',
    );
    expect(manage).toContain("returnPath: '/beeline/channels'");
    expect(manage).toContain('installation.installationId');
    expect(manage).toContain('refreshRepositories: () => loadRepoPicker(true)');
  });

  it('wires the install handlers and progress notice into the New Room dialog', () => {
    const dialogStart = deckSource.indexOf('<NewRoomDialog');
    expect(dialogStart).toBeGreaterThanOrEqual(0);
    const dialogEnd = deckSource.indexOf('{!!error && (', dialogStart);
    expect(dialogEnd, 'dialog JSX must precede the error bar').toBeGreaterThan(dialogStart);
    const dialog = deckSource.slice(dialogStart, dialogEnd);
    expect(dialog).toContain('repoPickerNotice={repoPickerNotice}');
    expect(dialog).toContain('handleAddGitHubAccount={() => void handleAddGitHubAccount()}');
    expect(dialog).toContain('handleManageGitHubInstallation={(installation) =>');
    expect(dialog).toContain('void handleManageGitHubInstallation(installation)');
  });
});
