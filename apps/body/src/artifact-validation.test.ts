import { describe, expect, it } from 'vitest';
import { ARTIFACT_MAXIMUM_BYTES, ARTIFACT_MIME_TYPES } from '@beeline/api-contract/daemon';
import { validateArtifact } from './artifact-validation.js';

const mb = (n: number) => Buffer.alloc(n);

describe('post_artifact validation matrix', () => {
  it.each([
    ['text/html', '<p>html</p>'],
    ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['application/pdf', '%PDF-1.7 minimal'],
    ['text/markdown', '# Markdown'],
    ['image/png', 'png'],
    ['image/jpeg', 'jpeg'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
    ['text/plain', 'plain'],
    ['application/json', '{}'],
    ['text/csv', 'a,b'],
    ['application/zip', 'zip'],
    ['application/octet-stream', 'bytes'],
  ])('accepts the inventoried %s lane', (mime, content) => {
    expect(() => validateArtifact(mime, Buffer.from(content), 'Artifact')).not.toThrow();
  });

  it('keeps the validation inventory exhaustive with the shared contract', () => {
    const tested = [
      'text/html',
      'image/svg+xml',
      'application/pdf',
      'text/markdown',
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'text/plain',
      'application/json',
      'text/csv',
      'application/zip',
      'application/octet-stream',
    ];
    expect(tested).toEqual([...ARTIFACT_MIME_TYPES]);
  });

  it('accepts a self-contained HTML page', () => {
    const html = Buffer.from(
      '<!doctype html><html><head><style>body{color:#111}</style></head>' +
        '<body><h1>Mock</h1><img src="data:image/png;base64,AAAA"><a href="#frame-2">next</a></body></html>',
    );
    expect(() => validateArtifact('text/html', html, 'Room list mock')).not.toThrow();
  });

  it('rejects every forbidden construct by name', () => {
    const cases: readonly [string, string][] = [
      ['script', '<html><body><script>alert(1)</script></body></html>'],
      ['script with src', '<script src="app.js"></script>'],
      ['link', '<html><head><link rel="stylesheet" href="theme.css"></head></html>'],
      ['iframe', '<iframe src="frame.html"></iframe>'],
      ['object', '<object data="movie.swf"></object>'],
      ['embed', '<embed src="plugin.swf">'],
      ['form', '<form action="/x"><input></form>'],
      ['inline onclick', '<button onclick="go()">Go</button>'],
      ['inline onload', '<body onload="init()">'],
      ['meta refresh', '<meta http-equiv="refresh" content="3;url=next.html">'],
      ['base', '<base href="https://evil.example/">'],
    ];
    for (const [what, fragment] of cases) {
      try {
        validateArtifact('text/html', Buffer.from(fragment), 't');
        expect.fail(`expected refusal for ${what}`);
      } catch (error) {
        expect((error as Error).message).toContain('self-contained');
      }
    }
  });

  it('rejects http(s) URLs in src, href, and CSS url()', () => {
    for (const fragment of [
      '<img src="https://cdn.example/pic.png">',
      "<img src='http://cdn.example/pic.png'>",
      '<img src=//cdn.example/pic.png>',
      '<a href="https://example.com">x</a>',
      '<style>body{background:url(https://cdn.example/bg.png)}</style>',
      "<style>body{background:url('http://cdn.example/bg.png')}</style>",
      '<svg><image xlink:href="https://cdn.example/i.png"/></svg>',
      '<svg><script>alert(1)</script></svg>',
      '<svg onload="wake()"><rect/></svg>',
    ]) {
      const mime = fragment.startsWith('<svg') ? 'image/svg+xml' : 'text/html';
      expect(() => validateArtifact(mime, Buffer.from(fragment), 't')).toThrow(/self-contained/);
    }
  });

  it('rejects script-scheme URLs', () => {
    expect(() =>
      validateArtifact('text/html', Buffer.from('<a href="javascript:alert(1)">x</a>'), 't'),
    ).toThrow(/self-contained/);
  });

  it('accepts an inline-styled SVG with data: images', () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:#d7af5f}</style>' +
        '<image href="data:image/png;base64,AAAA"/><rect width="10" height="10"/></svg>',
    );
    expect(() => validateArtifact('image/svg+xml', svg, 'Diagram')).not.toThrow();
  });

  it('requires a PDF to carry the %PDF- signature', () => {
    expect(() =>
      validateArtifact('application/pdf', Buffer.from('%PDF-1.7 fake'), 'Spec'),
    ).not.toThrow();
    expect(() => validateArtifact('application/pdf', Buffer.from('not a pdf'), 'Spec')).toThrow(
      /%PDF-/,
    );
  });

  it('checks size only for Markdown', () => {
    expect(() =>
      validateArtifact('text/markdown', Buffer.from('# Notes\n\n- one'), 'Notes'),
    ).not.toThrow();
    expect(() =>
      validateArtifact('text/markdown', Buffer.from('<script>x</script>'), 'Notes'),
    ).not.toThrow();
  });

  it('caps every format at the artifact ceiling', () => {
    for (const mime of ['text/html', 'image/svg+xml', 'application/pdf', 'text/markdown']) {
      const bytes =
        mime === 'application/pdf'
          ? Buffer.concat([Buffer.from('%PDF-'), mb(ARTIFACT_MAXIMUM_BYTES)])
          : mb(ARTIFACT_MAXIMUM_BYTES + 1);
      expect(() => validateArtifact(mime, bytes, 't')).toThrow(/-byte limit/);
    }
    expect(() =>
      validateArtifact(
        'application/pdf',
        Buffer.concat([Buffer.from('%PDF-'), mb(ARTIFACT_MAXIMUM_BYTES - 5)]),
        'Spec',
      ),
    ).not.toThrow();
  });

  it('refuses unknown mimes, empty artifacts, and empty titles', () => {
    expect(() => validateArtifact('audio/mpeg', Buffer.from('x'), 't')).toThrow(
      /mime must be one of/,
    );
    expect(() => validateArtifact('text/html', Buffer.alloc(0), 't')).toThrow(/empty/);
    expect(() => validateArtifact('text/html', Buffer.from('<p>hi</p>'), '  ')).toThrow(/title/);
  });
});
