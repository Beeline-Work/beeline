import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';

/** A server that has the card due at the 3rd reply and answers each tap with `starOutcome`. */
function shims(mobile: string, starOutcome: 'starred' | 'open'): Record<string, string> {
  const base = webProofShims(mobile);
  return {
    ...base,
    // TranscriptCard's settle motion, at rest.
    'react-native-reanimated': `${base['react-native-reanimated']}
      export const FadeOut = entering;
      export const interpolateColor = (_value, _input, output) => output[output.length - 1];`,
    '@/sync/transport/monolith-operation': `
      export const monolithPhoneOperation = async (name, input) => {
        if (name === 'readStarPrompt') return { prompt: { milestone: 3,
          repository: 'Beeline-Work/beeline', url: 'https://github.com/Beeline-Work/beeline' } };
        if (name !== 'answerStarPrompt') throw new Error('unexpected ' + name);
        window.__answers = [...(window.__answers ?? []), input];
        if (input.action === 'star') return ${JSON.stringify(
          starOutcome === 'open'
            ? { outcome: 'open', url: 'https://github.com/Beeline-Work/beeline' }
            : { outcome: 'starred' },
        )};
        return { outcome: input.action === 'later' ? 'later' : 'dismissed' };
      };`,
  };
}

describe.skipIf(!existsSync(CHROME))('GitHub star card in a browser', () => {
  const mobile = process.cwd();
  const run = (tap: string, starOutcome: 'starred' | 'open' = 'starred') =>
    runBrowserProof({
      entry: path.join(mobile, 'scripts/star-prompt-proof.tsx'),
      mobile,
      shims: shims(mobile, starOutcome),
      width: 390,
      query: tap ? `?tap=${tap}` : '',
    });

  it('shows the milestone, the repository, Not now, Star and a close control', async () => {
    const { result, status, stderr } = await run('');
    expect(status, stderr).toBe(0);
    expect(result).toContain('PASS');
    expect(result).toContain('Star Beeline on GitHub');
    expect(result).toContain('Your agents have answered you 3 times.');
    expect(result).toContain('Beeline-Work/beeline');
    expect(result).toContain('Not now');
    expect(result).toContain('★ Star');
    expect(result).toContain('✕');
  }, 90_000);

  it('stars in place and opens nothing when GitHub accepts the star', async () => {
    const { result, status, stderr } = await run('star');
    expect(status, stderr).toBe(0);
    expect(result).toContain('tapped star | card gone | opened: nothing');
    expect(result).toContain('sent: [{"action":"star","milestone":3}]');
  }, 90_000);

  it('opens the repository when the token cannot star', async () => {
    const { result, status, stderr } = await run('star', 'open');
    expect(status, stderr).toBe(0);
    expect(result).toContain(
      'tapped star | card gone | opened: https://github.com/Beeline-Work/beeline',
    );
  }, 90_000);

  it.each(['later', 'dismiss'])('hides the card after %s', async (tap) => {
    const { result, status, stderr } = await run(tap);
    expect(status, stderr).toBe(0);
    expect(result).toContain(`tapped ${tap} | card gone | opened: nothing`);
    expect(result).toContain(`sent: [{"action":"${tap}","milestone":3}]`);
  }, 90_000);
});
