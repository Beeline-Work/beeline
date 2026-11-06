import { describe, expect, it } from 'vitest';
import type { AgentTurnStep } from './acp.js';
import { MAX_NOTE_LENGTH, MAX_REPLY_STEPS, roomReplySteps } from './room-turn-steps.js';

const note = (text: string): AgentTurnStep => ({ kind: 'note', text });
const tool = (title: string): AgentTurnStep => ({
  kind: 'tool',
  call: { id: title, title, kind: 'other', status: 'completed' },
});
const noteText = (rows: ReturnType<typeof roomReplySteps>) =>
  rows.filter((row) => row.kind === 'note').map((row) => row.text).join('');

describe('roomReplySteps', () => {
  it('saves redacted output within a UTF-8 byte cap with a cut-off marker', () => {
    const step: AgentTurnStep = { kind: 'tool', call: {
      title: 'exec_command', content: [{ type: 'text', text: 'token=planted-secret\n-----BEGIN PRIVATE KEY-----\nplanted-pem\n-----END PRIVATE KEY-----\n' + '😀'.repeat(2000) }],
    } };
    const output = roomReplySteps([step])[0]!.output!;
    expect(output).not.toContain('planted-secret');
    expect(output).not.toContain('planted-pem');
    expect(output).toContain('[REDACTED]');
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(4096);
    expect(output).toMatch(/\[cut off\]$/);
  });

  it.each([
    { title: 'squire__fetch_credential' },
    { title: 'read_credential' },
    { title: 'read_file', rawInput: { path: '/tmp/.env' } },
    { title: 'exec_command', rawInput: { cmd: 'cat /tmp/credentials.json' } },
  ])('never saves secret-returning call contents: %j', (call) => {
    const rows = roomReplySteps([{ kind: 'tool', call: { ...call, content: 'planted-secret' } }]);
    expect(rows[0]!.output).toBe('Output hidden: contains a secret.');
    expect(JSON.stringify(rows)).not.toContain('planted-secret');
  });

  it.each(['.netrc', '_netrc', '.pgpass', '.git-credentials', '.npmrc', '.pypirc', '.docker/config.json', '.aws/credentials', '.env', '.envrc', '.env.local', 'id_rsa', 'id_ed25519', 'service.pem', 'service.key'])('hides synthetic credential-file reads of %s before persistence', (filename) => {
    for (const call of [
      { title: 'read_file', rawInput: { path: `/synthetic/${filename}` } },
      ...['cat', 'head', 'tail', 'less'].map(command => ({ title: 'exec_command', rawInput: { cmd: `${command} /synthetic/${filename}` } })),
    ]) {
      const rows = roomReplySteps([{ kind: 'tool', call: {
        ...call,
        content: 'machine example.invalid login synthetic password planted-netrc-password',
      } }]);
      expect(rows[0]!.output).toBe('Output hidden: contains a secret.');
      expect(JSON.stringify(rows)).not.toContain('planted-netrc-password');
    }
  });

  it.each([
    'machine example.invalid login synthetic password planted-netrc-password',
    'machine example.invalid\nlogin synthetic\npassword\nplanted-netrc-password',
    'machine example.invalid login synthetic passwd planted-netrc-password',
    'machine example.invalid\nlogin synthetic\npasswd\nplanted-netrc-password',
  ])('redacts synthetic netrc passwords before persistence: %s', (content) => {
    const rows = roomReplySteps([{ kind: 'tool', call: { title: 'exec_command', content } }]);
    expect(JSON.stringify(rows)).not.toContain('planted-netrc-password');
    expect(rows[0]!.output).toContain('[REDACTED]');
    expect(rows[0]!.output).toContain('machine example.invalid');
  });

  it.each(['machine example.invalid login planted-netrc-login', 'machine example.invalid\nlogin\nplanted-netrc-login'])('redacts synthetic netrc logins before persistence: %s', (content) => {
    const rows = roomReplySteps([{ kind: 'tool', call: { title: 'exec_command', content } }]);
    expect(JSON.stringify(rows)).not.toContain('planted-netrc-login');
    expect(rows[0]!.output).toContain('[REDACTED]');
  });

  it('keeps every note whole and in order between the tools', () => {
    expect(roomReplySteps([note('First.'), tool('a'), note('Second.'), tool('b')])).toEqual([
      { kind: 'note', title: 'Note', text: 'First.' },
      expect.objectContaining({ kind: 'tool', title: 'a' }),
      { kind: 'note', title: 'Note', text: 'Second.' },
      expect.objectContaining({ kind: 'tool', title: 'b' }),
    ]);
  });

  it('splits a note longer than the bound across continuing notes, losing nothing', () => {
    const long = `Start. ${'x'.repeat(MAX_NOTE_LENGTH)} End.`;
    const rows = roomReplySteps([note(long), tool('a')]);
    expect(rows.map((row) => [row.kind, row.continues ?? false])).toEqual([
      ['note', false],
      ['note', true],
      ['tool', false],
    ]);
    expect(rows.every((row) => (row.text ?? '').length <= MAX_NOTE_LENGTH)).toBe(true);
    expect(noteText(rows)).toBe(long);
  });

  it('never splits inside a surrogate pair', () => {
    const long = `${'x'.repeat(MAX_NOTE_LENGTH - 1)}😀tail`;
    const rows = roomReplySteps([note(long)]);
    expect(rows[0]!.text).toBe('x'.repeat(MAX_NOTE_LENGTH - 1));
    expect(noteText(rows)).toBe(long);
  });

  it('folds the oldest tools, never a note, when the steps exceed the bound', () => {
    const steps = [
      note('Before the tools.'),
      ...Array.from({ length: MAX_REPLY_STEPS }, (_, index) => tool(`t${index}`)),
    ];
    const rows = roomReplySteps(steps);
    expect(rows).toHaveLength(MAX_REPLY_STEPS);
    expect(rows[0]).toEqual({ kind: 'note', title: 'Note', text: 'Before the tools.' });
    expect(rows[1]).toMatchObject({ kind: 'tool', title: '2 earlier steps' });
    expect(rows.at(-1)).toMatchObject({ kind: 'tool', title: `t${MAX_REPLY_STEPS - 1}` });
  });

  it('keeps every note even when notes alone fill the bound', () => {
    const notes = Array.from({ length: MAX_REPLY_STEPS + 1 }, (_, index) => note(`n${index}`));
    const rows = roomReplySteps([...notes, tool('a')]);
    expect(rows.filter((row) => row.kind === 'note')).toHaveLength(MAX_REPLY_STEPS + 1);
    expect(rows.filter((row) => row.kind === 'tool')).toHaveLength(0);
  });
});
