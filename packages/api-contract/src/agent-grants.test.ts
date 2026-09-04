import { describe, expect, it } from 'vitest';
import {
  GRANT_SCRIPT_MAX_BYTES,
  GRANT_SCRIPT_MAX_LINES,
  commandGrantEscalations,
  commandGrantEscalationsBeyondRule,
  commandGrantMatches,
  commandRuleEscalations,
  formatGrantDecisionLine,
  formatGrantEscalationReason,
  grantScriptTooLongMessage,
  interpreterScriptArgument,
  isCommandGrantScript,
  parseCommandGrantTarget,
  parseGrantDecisionLine,
} from './agent-grants.js';

describe('command grant targets', () => {
  it('splits the approved line into an argv prefix and its named secrets', () => {
    expect(parseCommandGrantTarget('fly deploy -a beeline-preview --with FLY_TOKEN')).toEqual({
      argv: ['fly', 'deploy', '-a', 'beeline-preview'],
      secrets: ['FLY_TOKEN'],
    });
    expect(parseCommandGrantTarget('npm test')).toEqual({ argv: ['npm', 'test'], secrets: [] });
  });

  it('refuses shell metacharacters, malformed --with, and sloppy spacing', () => {
    for (const target of [
      'fly deploy; rm -rf /',
      'fly deploy && echo',
      'echo $HOME',
      'cat file > out',
      'fly deploy `id`',
      "fly deploy 'x'",
      'fly deploy *',
    ]) {
      expect(() => parseCommandGrantTarget(target)).toThrow('shell metacharacters');
    }
    expect(() => parseCommandGrantTarget('fly deploy --with')).toThrow('--with must name');
    expect(() => parseCommandGrantTarget('fly deploy --with fly_token')).toThrow('--with must name');
    expect(() => parseCommandGrantTarget('fly --with TOKEN deploy')).toThrow('must come after');
    expect(() => parseCommandGrantTarget(' fly deploy')).toThrow('single spaces');
    expect(() => parseCommandGrantTarget('fly  deploy')).toThrow('single spaces');
    expect(() => parseCommandGrantTarget('')).toThrow('required');
    expect(() => parseCommandGrantTarget('--with TOKEN')).toThrow('must name a command');
  });

  it('matches only when the approved argv is a word-for-word prefix', () => {
    const rule = parseCommandGrantTarget('fly deploy -a beeline-preview --with FLY_TOKEN');
    expect(commandGrantMatches(rule, ['fly', 'deploy', '-a', 'beeline-preview'])).toBe(true);
    expect(
      commandGrantMatches(rule, ['fly', 'deploy', '-a', 'beeline-preview', '--strategy', 'rolling']),
    ).toBe(true);
    expect(commandGrantMatches(rule, ['fly', 'deploy', '-a', 'beeline-prod'])).toBe(false);
    expect(commandGrantMatches(rule, ['fly', 'deploy'])).toBe(false);
    expect(commandGrantMatches(rule, ['flyctl', 'deploy', '-a', 'beeline-preview'])).toBe(false);
  });
});

describe('grant decision lines', () => {
  it('round-trips every decision through one format', () => {
    for (const decision of ['always', 'once', 'deny'] as const) {
      const line = formatGrantDecisionLine({
        deciderName: 'Charles Bee',
        decision,
        kind: 'command',
        target: 'fly deploy -a beeline-preview --with FLY_TOKEN',
      });
      expect(parseGrantDecisionLine(line)).toEqual({
        deciderName: 'Charles Bee',
        decision,
        kind: 'command',
        target: 'fly deploy -a beeline-preview --with FLY_TOKEN',
      });
    }
    expect(
      formatGrantDecisionLine({
        deciderName: 'Charles',
        decision: 'once',
        kind: 'host',
        target: 'api.fly.io',
      }),
    ).toBe('Charles approved once host api.fly.io');
  });

  it('does not mistake ordinary system lines for decisions', () => {
    expect(parseGrantDecisionLine('Beeline Scheduler ran a schedule for Bee · check the deploy')).toBeUndefined();
    expect(parseGrantDecisionLine('Owner turned yolo on for Bee')).toBeUndefined();
    expect(parseGrantDecisionLine('Charles approved nothing here')).toBeUndefined();
    expect(
      parseGrantDecisionLine('Bee was granted command npm test · auto-approved under yolo'),
    ).toBeUndefined();
  });
});

/**
 * C94. Every line quoted here is one Goosy actually ran in `#Charles`, from a
 * Room whose stated guarantee is a read-only filesystem, every one of them
 * auto-approved under yolo.
 */
describe('the two hard stops', () => {
  it('stops a script nobody has read, and nothing else about an interpreter', () => {
    const script = { path: 'fix.py', sha256: 'a'.repeat(64), bytes: 4, contents: 'x' };
    expect(commandRuleEscalations(parseCommandGrantTarget('python3 fix.py'), script)).toEqual([
      'unseen-script',
    ]);
    // Nothing unseen about a version flag, and yolo is the scope gate.
    expect(commandRuleEscalations(parseCommandGrantTarget('python3 -V'))).toEqual([]);
    expect(commandRuleEscalations(parseCommandGrantTarget('npm test'))).toEqual([]);
    // A secret the rule names is scope, not a hard stop: both surfaces may read one.
    expect(commandRuleEscalations(parseCommandGrantTarget('fly deploy --with FLY_TOKEN'))).toEqual(
      [],
    );
  });

  it('stops a credential or environment file wherever it sits in the line', () => {
    expect(commandGrantEscalations(['cut', '-d=', '-f1', '/home/op/proj-burdie/.env'])).toEqual([
      'credential',
    ]);
    expect(commandGrantEscalations(['cat', '.env.production'])).toEqual(['credential']);
    expect(commandGrantEscalations(['cp', 'staging.env', 'out'])).toEqual(['credential']);
    expect(commandGrantEscalations(['cat', '/home/op/.ssh/id_ed25519'])).toEqual(['credential']);
    expect(commandGrantEscalations(['cat', '/home/op/.config/gh/hosts.yml'])).toEqual([
      'credential',
    ]);
    expect(commandGrantEscalations(['grep', 'x', 'secrets.json'])).toEqual(['credential']);
    expect(commandGrantEscalations(['cat', '--file=/etc/app/api_key.pem'])).toEqual(['credential']);
    // Ordinary work is not a stop, and neither is a name that merely contains
    // the letters: this must not become more friction than it is worth.
    expect(commandGrantEscalations(['npm', 'test'])).toEqual([]);
    expect(commandGrantEscalations(['env', 'FOO=1', 'npm', 'test'])).toEqual([]);
    expect(commandGrantEscalations(['cat', 'src/environment.ts'])).toEqual([]);
    expect(commandGrantEscalations(['cat', 'tokenizer.py'])).toEqual([]);
  });

  it('lets an approved shape run and stops what the prefix never showed', () => {
    const rule = parseCommandGrantTarget('cut -d=');
    expect(commandGrantEscalationsBeyondRule(rule, ['cut', '-d=', '-f1', 'names.csv'])).toEqual([]);
    expect(commandGrantEscalationsBeyondRule(rule, ['cut', '-d=', '-f1', '.env'])).toEqual([
      'credential',
    ]);
    const approved = parseCommandGrantTarget('cut -d= -f1 .env');
    expect(commandGrantEscalationsBeyondRule(approved, ['cut', '-d=', '-f1', '.env'])).toEqual([]);
  });

  it('names why a human has to answer', () => {
    expect(formatGrantEscalationReason([])).toBeUndefined();
    expect(formatGrantEscalationReason(['unseen-script', 'credential'])).toBe(
      'it runs a script whose contents nobody has read and it names a credential or environment file',
    );
  });
});

describe('an interpreter grant is bound to its script', () => {
  it('finds the file the command line does not describe, through any wrapper', () => {
    expect(interpreterScriptArgument(['python3', '-u', 'fix.py', '--dry'])).toEqual({
      index: 2,
      path: 'fix.py',
    });
    expect(interpreterScriptArgument(['node', 'x.js'])).toEqual({ index: 1, path: 'x.js' });
    // A wrapper must not be a way around the binding.
    expect(interpreterScriptArgument(['env', 'FOO=1', 'python3', 'fix.py'])).toEqual({
      index: 3,
      path: 'fix.py',
    });
    expect(interpreterScriptArgument(['timeout', '30', 'bash', 'deploy.sh'])).toEqual({
      index: 3,
      path: 'deploy.sh',
    });
    // No file to bind: `python3 -V` is not a hard stop.
    expect(interpreterScriptArgument(['python3', '-V'])).toBeUndefined();
    expect(interpreterScriptArgument(['npm', 'test'])).toBeUndefined();
    expect(interpreterScriptArgument(['env', 'FOO=1', 'npm', 'test'])).toBeUndefined();
  });

  it('accepts only a whole binding, and refuses rather than truncating an unreadable one', () => {
    expect(isCommandGrantScript({ path: 'x.py', sha256: 'a'.repeat(64), bytes: 3, contents: 'a' })).toBe(
      true,
    );
    expect(isCommandGrantScript({ path: 'x.py', sha256: 'nope', bytes: 3, contents: 'a' })).toBe(false);
    expect(isCommandGrantScript(undefined)).toBe(false);
    expect(GRANT_SCRIPT_MAX_BYTES).toBe(4_096);
    expect(GRANT_SCRIPT_MAX_LINES).toBe(120);
    const refusal = grantScriptTooLongMessage('big.py', 9_000, 400);
    expect(refusal).toContain('will not be truncated');
    expect(refusal).toContain('open_corner');
  });
});
