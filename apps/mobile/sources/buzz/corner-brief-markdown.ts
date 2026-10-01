import type { RoomView } from '@beeline/api-contract/phone';

export type CornerBrief = NonNullable<RoomView['cornerBrief']>;

/**
 * The corner brief as one Markdown document for the full-screen viewer, in the
 * order it carries authority: the spec, then the human message that approved
 * it (quoted exactly), then the files the agent was handed. Only the latest
 * revision is ever composed — the brief has no history on the phone.
 */
export function cornerBriefMarkdown(brief: CornerBrief): string {
  const sections: string[] = [];
  const spec = brief.spec.trim();
  if (spec) sections.push(spec);
  if (brief.approval) {
    const { approverName, sourceMessageId, text } = brief.approval;
    sections.push(
      [
        '## Approval',
        `Approved by ${approverName}, message ${sourceMessageId}:`,
        text
          .split('\n')
          .map((line) => (line ? `> ${line}` : '>'))
          .join('\n'),
      ].join('\n\n'),
    );
  }
  if (brief.attachments.length) {
    sections.push(['## Files', brief.attachments.map(fileLine).join('\n')].join('\n\n'));
  }
  return sections.join('\n\n');
}

function fileLine(file: CornerBrief['attachments'][number]): string {
  // The span parser ends a link label at the first `]` and its target at the
  // first `)`; percent-encoding keeps the target intact, and a label it cannot
  // carry falls back to the title followed by the bare (auto-linked) URL.
  const url = file.url.replace(/[()\s]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
  const title = file.title.trim() || url;
  const link = title.includes(']') ? `${title} ${url}` : `[${title}](${url})`;
  const purpose = file.purpose.trim();
  return `- ${link}${purpose ? ` — ${purpose}` : ''}${file.required ? ' · required' : ''}`;
}
