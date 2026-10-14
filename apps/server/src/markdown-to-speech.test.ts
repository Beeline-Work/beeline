import { expect, it } from 'vitest';
import { markdownToSpeech, MarkdownSpeechStream } from './markdown-to-speech.js';

it.each([
  ['**bold** and *italic* and _soft_ and __strong__', 'bold and italic and soft and strong'],
  ['# Heading\n> Quote\n- First\n* Second\n1. Third', 'Heading. Quote. First. Second. Third'],
  ['[Beeline](https://usebeeline.com) and `code`', 'Beeline and code'],
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
  const input = '**Hello, friend.**\n\n[Visit](https://example.com).\n\n```ts\nignored, text.\n\nmore code\n```\n\nBye @jellybean.';
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
