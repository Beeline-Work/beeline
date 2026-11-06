/** Selected model responses carry their settlement receipt in the SDK's
 * response ID. Provider IDs and DONE can never supply that evidence. The
 * original stream remains available to the caller's billing parser. */
export class OwnedModelStream {
  private buffer = '';
  private data: string[] = [];
  done = false;
  finishReason: string | null = null;

  push(text: string): string[] {
    this.buffer += text;
    const output: string[] = [];
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      if (!line) {
        if (this.data.length) {
          const value = this.data.join('\n');
          if (this.done) throw new Error('Owned model data after terminal delimiter');
          if (value === '[DONE]') this.done = true;
          else {
            const chunk: unknown = JSON.parse(value);
            if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk) || 'error' in chunk)
              throw new Error('Invalid owned model event');
            const record = chunk as Record<string, unknown>;
            delete record.id;
            if (Array.isArray(record.choices)) for (const choice of record.choices) {
              if (!choice || typeof choice !== 'object') throw new Error('Invalid owned model choice');
              const reason = choice.finish_reason;
              if (reason != null) {
                if (!['stop', 'length', 'tool_calls', 'content_filter', 'function_call'].includes(reason))
                  throw new Error('Invalid owned model finish reason');
                this.finishReason = reason;
                // Only the committed server terminal chunk finishes the SDK.
                choice.finish_reason = null;
              }
            }
            output.push(`data: ${JSON.stringify(record)}\n\n`);
          }
        }
        this.data = [];
      } else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
      // Provider event IDs/retry hints are deliberately not forwarded.
    }
    return output;
  }

  complete(): boolean { return this.done && !this.buffer.trim() && !this.data.length; }

  terminal(receipt: string): string {
    if (!this.complete()) throw new Error('Owned model stream is incomplete');
    return `data: ${JSON.stringify({ id: receipt, object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: this.finishReason ?? 'stop' }] })}\n\ndata: [DONE]\n\n`;
  }
}
