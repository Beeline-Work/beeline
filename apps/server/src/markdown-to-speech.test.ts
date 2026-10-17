import { expect, it } from 'vitest';
import { markdownToSpeech, MarkdownSpeechStream } from './markdown-to-speech.js';

it.each([
  ['**bold** and *italic* and _soft_ and __strong__', 'bold and italic and soft and strong'],
  ['# Heading\n> Quote\n- First\n* Second\n1. Third', 'Heading. Quote. First. Second. Third'],
  ['[Beeline](https://usebeeline.com) and `code`', 'Beeline and code'],
  ['[Visit](https://example.com/a_(b)/details)', 'Visit'],
  ['[Visit](https://example.com/a_(b_(c))/details)', 'Visit'],
  ['[Visit](https://example.com/a_\\(b\\)/details)', 'Visit'],
  ['Before\n```ts\nconst secret = 1;\n```\nAfter', 'Before. After'],
  ['Before\n~~~js\nnot spoken\n~~~\nAfter', 'Before. After'],
  ['Before\n```js\nunfinished code', 'Before'],
  ['| Name | Value |\n| --- | --- |\n| A | B |', 'Name, Value. A, B'],
  ['Hi @jellybean, 2*3 and snake_case.', 'Hi jellybean, 2*3 and snake_case.'],
  ['[excited] **Great** news!', '[excited] Great news!'],
  ['Title\n=====\n\nText', 'Title. Text'],
  ['## Title ##\n>> Nested quote', 'Title. Nested quote'],
  ['[label][ref]\n\n[ref]: https://example.com', 'label'],
  ['````js\n```\n\nprivate code\n````\nAfter', 'After'],
])('speaks %s as natural text', (input, expected) => {
  expect(markdownToSpeech(input)).toBe(expected);
});

it('holds streamed list numbers and skips code-only paragraphs', () => {
  const stream = new MarkdownSpeechStream();
  expect(stream.push('1. ')).toEqual([]);
  expect(stream.push('First\n2. Second\n\n')).toEqual(['First. Second']);
  expect(stream.push('```ts\nprivate\n```\n\n')).toEqual([]);
  expect(stream.finish()).toBe('');
});

it('retains split bold, links and fences across every possible chunk boundary', () => {
  const input = '**Hello, friend.**\n\n[Visit](https://example.com/a_(b)/details).\n\n```ts\nignored, text.\n\nmore code\n```\n\nBye @jellybean.';
  for (let at = 0; at <= input.length; at++) {
    const stream = new MarkdownSpeechStream();
    const spoken = [...stream.push(input.slice(0, at)), ...stream.push(input.slice(at)), stream.finish()].filter(Boolean).join(' ');
    expect(spoken).toBe('Hello, friend. Visit. Bye jellybean.');
  }
});

it('starts plain prose before generation completes', () => {
  const stream = new MarkdownSpeechStream();
  expect(stream.push('Hello, friend')).toEqual(['Hello,']);
  expect(stream.finish()).toBe('friend');
});

const members = [{ handle: 'bananaman614305', name: 'Bananaman' }];

it('Reproduction VOICE-IDS-1: speaks handles and drops machine identifiers', () => {
  // Old code kept every token verbatim: "Hi bananaman614305, a bug (fb_...)."
  expect(markdownToSpeech('Hi @bananaman614305, a bug (fb_409eec12d3be6644d9eba2bf).', members))
    .toBe('Hi Bananaman, a bug.');
  expect(markdownToSpeech('Hi @bananaman614305, a bug (fb_409eec12d3be6644d9eba2bf).'))
    .toBe('Hi bananaman, a bug.');
  expect(markdownToSpeech('Hi bananaman614305.', members)).toBe('Hi Bananaman.');
  expect(markdownToSpeech('Commit 0123456789abcdef0123456789abcdef01234567 is live.'))
    .toBe('Commit is live.');
  expect(markdownToSpeech('Join 123e4567-e89b-12d3-a456-426614174000 now.'))
    .toBe('Join now.');
  expect(markdownToSpeech('Message ID: msg_abc123xyz done.')).toBe('Message done.');
  expect(markdownToSpeech('Machine 857614db620078 ready.')).toBe('Machine ready.');
});

it('keeps ordinary numbers, times, versions and digit-bearing words', () => {
  const input = 'Wait 60 minutes, PR 2546 at 20:37, version 1.2.3, B2B, MP3, H264, COVID-19, March2026, defaced.';
  expect(markdownToSpeech(input)).toBe(input);
});

it('Reproduction VOICE-IDS-2: keeps long ordinary numbers while dropping lettered hex', () => {
  expect(markdownToSpeech('Population 12345678 people.')).toBe('Population 12345678 people.');
  expect(markdownToSpeech('Call 1234567890 and 12345678901234567890 now.')).toBe('Call 1234567890 and 12345678901234567890 now.');
  expect(markdownToSpeech('Order 00000000000000000001 shipped.')).toBe('Order 00000000000000000001 shipped.');
  expect(markdownToSpeech('Hash 0123456789abcdef0123456789abcdef01234567.')).toBe('Hash.');
  expect(markdownToSpeech('Hex deadbeef12345678 and abcdefabcdefabcdef.')).toBe('Hex and.');
  expect(markdownToSpeech('The defaced facade stays.')).toBe('The defaced facade stays.');
});

it('Reproduction VOICE-IDS-3: keeps digits-only and number-punctuation tokens out of the ID filter', () => {
  const input = 'Population 12345678, total 1,234,567, pi 3.14, meet at 20:37, year 2026, PR 2547, ref 12345678901234567890.';
  expect(markdownToSpeech(input)).toBe(input);
  for (const token of ['12345678', '1,234,567', '3.14', '20:37', '2026', 'PR 2547']) {
    expect(markdownToSpeech(`Keep ${token} here.`), token).toBe(`Keep ${token} here.`);
  }
  // Lettered hex, SHAs, UUIDs and feedback ids still drop.
  expect(markdownToSpeech('Hex deadbeef12345678 and 123e4567-e89b-12d3-a456-426614174000 and fb_409eec12d3be6644d9eba2bf.'))
    .toBe('Hex and and.');
  // Streaming cannot split a number or turn it into an identifier.
  for (let at = 0; at <= input.length; at++) {
    const stream = new MarkdownSpeechStream();
    const spoken = [...stream.push(input.slice(0, at)), ...stream.push(input.slice(at)), stream.finish()]
      .filter(Boolean).join(' ');
    expect(spoken, `split at ${at}`).toBe(input);
  }
});

it('speaks identifiers the same way when streamed in any chunk size', () => {
  const input = 'I filed this as a bug (fb_409eec12d3be6644d9eba2bf). Hi @bananaman614305, PR 2546 at 20:37, version 1.2.3.\n\n'
    + 'Commit 0123456789abcdef0123456789abcdef01234567 and 123e4567-e89b-12d3-a456-426614174000.';
  const full = markdownToSpeech(input, members);
  expect(full).toBe('I filed this as a bug. Hi Bananaman, PR 2546 at 20:37, version 1.2.3. Commit and.');
  for (let at = 0; at <= input.length; at++) {
    const stream = new MarkdownSpeechStream(members);
    const spoken = [...stream.push(input.slice(0, at)), ...stream.push(input.slice(at)), stream.finish()]
      .filter(Boolean).join(' ');
    expect(spoken, `split at ${at}`).toBe(full);
  }
  for (let seed = 1; seed <= 20; seed++) {
    let cursor = 0; let random = seed; const stream = new MarkdownSpeechStream(members); const phrases: string[] = [];
    while (cursor < input.length) {
      random = (random * 48271) % 2147483647;
      const next = Math.min(input.length, cursor + (random % 17) + 1);
      phrases.push(...stream.push(input.slice(cursor, next))); cursor = next;
    }
    phrases.push(stream.finish());
    expect(phrases.filter(Boolean).join(' '), `seed ${seed}`).toBe(full);
  }
});
