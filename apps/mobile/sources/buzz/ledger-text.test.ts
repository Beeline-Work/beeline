import { describe, expect, it } from 'vitest';
import { decodePercentEncoding, splitLedgerText } from './ledger-text';

describe('decodePercentEncoding', () => {
  it('renders a percent-escaped character as the character', () => {
    expect(decodePercentEncoding('Should I rebase%3F')).toBe('Should I rebase?');
    expect(decodePercentEncoding('a%20b%20c')).toBe('a b c');
  });

  it('decodes a multi-byte run as one sequence', () => {
    expect(decodePercentEncoding('done %E2%9C%93')).toBe('done ✓');
  });

  it('leaves anything that is not an escape exactly as written', () => {
    expect(decodePercentEncoding('coverage rose to 100%')).toBe('coverage rose to 100%');
    expect(decodePercentEncoding('50% of 3%z runs')).toBe('50% of 3%z runs');
    expect(decodePercentEncoding('truncated %3')).toBe('truncated %3');
    expect(decodePercentEncoding('no escapes here')).toBe('no escapes here');
  });

  it('keeps an invalid UTF-8 run literal instead of throwing', () => {
    expect(decodePercentEncoding('bad %E0%A4%A')).toBe('bad %E0%A4%A');
    expect(decodePercentEncoding('lone %FF byte')).toBe('lone %FF byte');
  });
});

describe('splitLedgerText', () => {
  const PUSH_REJECTION = [
    'I tried to push the branch but the remote refused it.',
    '',
    'To https://github.com/acme/widgets.git',
    ' ! [rejected]        fm/thing -> fm/thing (fetch first)',
    "error: failed to push some refs to 'https://github.com/acme/widgets.git'",
    'hint: Updates were rejected because the remote contains work that you do',
    'hint: not have locally. Fetch first.',
    '',
    'Want me to rebase onto the new tip?',
  ].join('\n');

  it('lifts a git push rejection dump out of the prose', () => {
    const split = splitLedgerText(PUSH_REJECTION);
    expect(split.prose).toBe(
      'I tried to push the branch but the remote refused it.\n\nWant me to rebase onto the new tip?',
    );
    expect(split.machine).toContain('! [rejected]');
    expect(split.machine).toContain('hint: Updates were rejected');
    expect(split.machineLines).toBe(5);
  });

  it('lifts a dump written directly under its sentence, with no blank line', () => {
    // The shape that actually reaches a corner: the agent introduces the
    // failure and pastes the output on the very next line. A blank-line-block
    // rule would have swallowed the sentence with it, or missed the dump.
    const split = splitLedgerText(
      [
        'I pushed the branch and the remote refused it:',
        'To https://github.com/acme/widgets.git',
        ' ! [rejected]        fm/thing -> fm/thing (fetch first)',
        "error: failed to push some refs to 'https://github.com/acme/widgets.git'",
        'hint: Updates were rejected because the remote contains work that you do',
        'hint: not have locally.',
        'Want me to rebase onto the new tip?',
      ].join('\n'),
    );
    expect(split.prose).toBe(
      'I pushed the branch and the remote refused it:\nWant me to rebase onto the new tip?',
    );
    expect(split.machine).toContain('! [rejected]');
    expect(split.machineLines).toBe(5);
  });

  it('keeps blank lines inside a run instead of splitting one dump into fragments', () => {
    const split = splitLedgerText(
      [
        'Here is the whole failure.',
        'remote: Enumerating objects: 12, done.',
        '',
        'To git@github.com:acme/widgets.git',
        ' ! [rejected]        main -> main (non-fast-forward)',
        'error: failed to push some refs',
      ].join('\n'),
    );
    expect(split.prose).toBe('Here is the whole failure.');
    expect(split.machine).toContain('Enumerating objects');
    expect(split.machine).toContain('failed to push some refs');
  });

  it('leaves a single quoted diagnostic in the prose it belongs to', () => {
    // Two machine-ish lines is an agent talking *about* an error; three is a
    // dump. This boundary is the difference between quieting the slab and
    // hiding what the agent said.
    const prose = 'The build stopped at:\nerror: missing semicolon\nI can fix that in one edit.';
    expect(splitLedgerText(prose).machine).toBeUndefined();
    expect(splitLedgerText(prose).prose).toBe(prose);
  });

  it('lifts a fenced block of output while leaving authored code fenced', () => {
    const output = splitLedgerText(
      'Here is what happened:\n\n```\nnpm ERR! code ELIFECYCLE\nnpm ERR! errno 1\n```\n',
    );
    expect(output.machine).toContain('npm ERR! code ELIFECYCLE');
    expect(output.prose).toBe('Here is what happened:');

    const code = splitLedgerText(
      'I changed the guard:\n\n```ts\nif (!ready) return;\nconsole.log(value);\n```\n',
    );
    expect(code.machine).toBeUndefined();
    expect(code.prose).toContain('```ts');
    expect(code.prose).toContain('if (!ready) return;');
  });

  it('lifts a stack trace', () => {
    const split = splitLedgerText(
      'The suite failed.\n\n' +
        'TypeError: cannot read length of undefined\n' +
        '    at parse (/app/src/parse.ts:12:9)\n' +
        '    at run (/app/src/run.ts:44:3)\n',
    );
    expect(split.machine).toContain('TypeError: cannot read length of undefined');
    expect(split.prose).toBe('The suite failed.');
  });

  it('never eats ordinary prose, however long', () => {
    const prose = [
      'I read the scheduler and the stall is in the retry path.',
      'The error surfaces because the callback resolves twice.',
      'I can fix it by moving the guard, or by dropping the retry entirely.',
      'Which would you rather?',
    ].join('\n');
    const split = splitLedgerText(prose);
    expect(split.machine).toBeUndefined();
    expect(split.prose).toBe(prose);
    expect(split.machineLines).toBe(0);
  });

  it('leaves a single mention of git untouched — it takes a wall, not a word', () => {
    const split = splitLedgerText('The push failed.\nI will fetch first and retry.');
    expect(split.machine).toBeUndefined();
    expect(split.prose).toBe('The push failed.\nI will fetch first and retry.');
  });

  it('short-circuits a single-line message', () => {
    const split = splitLedgerText('error: failed to push some refs');
    expect(split.machine).toBeUndefined();
    expect(split.prose).toBe('error: failed to push some refs');
  });

  it('can collapse a message that is nothing but output', () => {
    const split = splitLedgerText(
      'hint: fetch first\nhint: see the note about fast-forwards\nerror: failed to push some refs',
    );
    expect(split.prose).toBe('');
    expect(split.machineLines).toBe(3);
  });
});
