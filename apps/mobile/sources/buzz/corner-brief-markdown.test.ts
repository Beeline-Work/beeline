import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '@/components/markdown/parseMarkdown';
import { cornerBriefMarkdown, type CornerBrief } from './corner-brief-markdown';

function brief(overrides: Partial<CornerBrief> = {}): CornerBrief {
  return {
    revision: 3,
    spec: '# Ship the brief link\n\nOpen the latest brief from the objective line.',
    approval: {
      sourceMessageId: 'msg-42',
      text: 'Yes, build it.\n\nKeep it small.',
      approverName: 'Alan',
    },
    attachments: [
      { title: 'Mock', purpose: 'The approved layout', required: true, url: 'https://files.example/mock.png' },
      { title: 'Notes', purpose: 'Background', required: false, url: 'https://files.example/notes.md' },
    ],
    ...overrides,
  };
}

describe('cornerBriefMarkdown', () => {
  it('composes the spec, then the exact approval quote, then the files', () => {
    expect(cornerBriefMarkdown(brief())).toBe(
      [
        '# Ship the brief link',
        '',
        'Open the latest brief from the objective line.',
        '',
        '## Approval',
        '',
        'Approved by Alan, message msg-42:',
        '',
        '> Yes, build it.',
        '>',
        '> Keep it small.',
        '',
        '## Files',
        '',
        '- [Mock](https://files.example/mock.png) — The approved layout · required',
        '- [Notes](https://files.example/notes.md) — Background',
      ].join('\n'),
    );
  });

  it('keeps the approving message verbatim through the document renderer', () => {
    const text = 'Approved — ship *exactly* this.\nSecond line.';
    const blocks = parseMarkdown(
      cornerBriefMarkdown(brief({ approval: { sourceMessageId: 'm1', text, approverName: 'Bo' } })),
      true,
    );
    const quote = blocks.find((block) => block.type === 'quote');
    expect(quote?.type === 'quote' && quote.content.map((span) => span.text).join('')).toBe(
      'Approved — ship exactly this.\nSecond line.',
    );
  });

  it('omits the approval and files sections when there are none', () => {
    expect(cornerBriefMarkdown(brief({ approval: undefined, attachments: [] }))).toBe(
      '# Ship the brief link\n\nOpen the latest brief from the objective line.',
    );
  });

  it('keeps file links whole when the title or URL would break the link syntax', () => {
    const markdown = cornerBriefMarkdown(
      brief({
        spec: 'Spec',
        approval: undefined,
        attachments: [
          { title: 'Plan', purpose: '', required: false, url: 'https://files.example/a (1).md' },
          { title: 'Odd ] title', purpose: 'Edge', required: true, url: 'https://files.example/b.md' },
        ],
      }),
    );
    expect(markdown).toContain('- [Plan](https://files.example/a%20%281%29.md)');
    expect(markdown).toContain('- Odd ] title https://files.example/b.md — Edge · required');
    const list = parseMarkdown(markdown, true).find((block) => block.type === 'list');
    const urls =
      list?.type === 'list'
        ? list.items.flatMap((item) => item.spans.flatMap((span) => (span.url ? [span.url] : [])))
        : [];
    expect(urls).toEqual(['https://files.example/a%20%281%29.md', 'https://files.example/b.md']);
  });
});
