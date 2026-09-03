import { describe, expect, it } from 'vitest';
import {
  commandGrantMatches,
  formatGrantDecisionLine,
  formatYoloAutoApprovedLine,
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
    ).toBe('Charles approved once: host api.fly.io');
  });

  it('does not mistake ordinary system lines for decisions', () => {
    expect(parseGrantDecisionLine('Scheduled: check the deploy')).toBeUndefined();
    expect(parseGrantDecisionLine('Owner turned yolo on for Bee')).toBeUndefined();
    expect(parseGrantDecisionLine('Charles approved: nothing here')).toBeUndefined();
    expect(
      parseGrantDecisionLine(
        formatYoloAutoApprovedLine({ kind: 'command', target: 'npm test', requesterName: 'Alex' }),
      ),
    ).toBeUndefined();
  });
});
