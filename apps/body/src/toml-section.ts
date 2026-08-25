/**
 * Minimal TOML top-level-table extraction for harness config passthrough.
 *
 * The daemon needs to copy an operator's `[mcp_servers.*]` tables out of
 * `~/.codex/config.toml` / `~/.grok/config.toml` into an isolated harness home
 * (`agent-home.ts`) WITHOUT carrying the rest of the file — the operator's
 * model/sandbox/approval settings there would fight the daemon's own agent-mode
 * flags. Adding a full TOML parser dependency to the CLI bundle for one
 * extraction shape is not worth it, so this module implements exactly the
 * subset such configs use: comments, basic/literal strings (single- and
 * multi-line), dotted and quoted table headers, and values spanning multiple
 * lines (arrays, inline tables).
 *
 * Extraction returns RAW TEXT SLICES of the matching tables rather than parsed
 * structures that are re-serialized: re-emitting the operator's own bytes
 * cannot invent syntax a stricter TOML parser would reject.
 */

interface LineScan {
  /** Line with any comment removed (quotes honoured). */
  code: string;
  /**
   * Net bracket/brace depth change outside strings — positive means a value
   * continues onto the following lines.
   */
  depthDelta: number;
}

/**
 * Scan one physical line of a possibly multi-line string/inline value.
 * `openString` carries multi-line-string state across calls ('"""' basic or
 * "'''" literal); it is updated in place.
 */
function scanLine(line: string, openString: { kind: 'basic' | 'literal' | null }): LineScan {
  if (openString.kind) {
    const closer = openString.kind === 'basic' ? '"""' : "'''";
    const end = line.indexOf(closer);
    if (end === -1) return { code: '', depthDelta: 0 };
    // Resume scanning after the closing delimiter.
    openString.kind = null;
    return scanLine(line.slice(end + 3), openString);
  }

  let depth = 0;
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    if (rest.startsWith('"""') || rest.startsWith("'''")) {
      const kind = rest.startsWith('"""') ? 'basic' : 'literal';
      const closer = kind === 'basic' ? '"""' : "'''";
      const end = rest.indexOf(closer, 3);
      if (end === -1) {
        openString.kind = kind;
        return { code: line.slice(0, i), depthDelta: depth };
      }
      i += end + 6;
      continue;
    }
    const ch = rest[0]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') {
      // Single-line basic string: skip to its close on this line.
      let j = 1;
      while (j < rest.length && rest[j] !== '"') {
        if (rest[j] === '\\') j++;
        j++;
      }
      i += j + 1;
      continue;
    }
    if (ch === "'") {
      const end = rest.indexOf("'", 1);
      i += end === -1 ? rest.length - i : end + 1;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    else if (ch === '#') return { code: line.slice(0, i), depthDelta: depth };
    i++;
  }
  return { code: line, depthDelta: depth };
}

/**
 * Parse a `[a.b."c.d"]` (or `[a]`) header into its key path, or `undefined`
 * when the line is not a table header. `[[array of tables]]` headers are
 * deliberately not matched — no MCP config uses them.
 */
export function parseTomlTableHeader(line: string): string[] | undefined {
  const match = /^\s*\[\s*(.*?)\s*\]\s*$/.exec(line);
  if (!match) return undefined;
  const inner = match[1]!;
  if (inner.startsWith('[')) return undefined;
  const path: string[] = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === '"' || inner[i] === "'") {
      const quote = inner[i]!;
      const end = inner.indexOf(quote, i + 1);
      if (end === -1) return undefined;
      path.push(inner.slice(i + 1, end));
      i = end + 1;
    } else {
      const dot = inner.indexOf('.', i);
      const segment = dot === -1 ? inner.slice(i) : inner.slice(i, dot);
      const trimmed = segment.trim();
      if (!trimmed) return undefined;
      path.push(trimmed);
      if (dot === -1) break;
      i = dot + 1;
    }
    // Skip the separator after a quoted segment.
    while (i < inner.length && (inner[i] === '.' || inner[i] === ' ')) i++;
  }
  return path;
}

/**
 * Extract the raw text of every top-level table whose header path starts with
 * `prefixPath` (sub-tables included — `[mcp_servers.x.env]` rides along with
 * its server), preserving the source formatting verbatim. Returns the joined
 * sections, or `undefined` when nothing matches.
 */
export function extractTomlSections(
  source: string,
  prefixPath: readonly string[],
  excludedChildren: readonly string[] = [],
): string | undefined {
  const lines = source.split(/\r?\n/);
  const collected: string[] = [];
  let inMatchedTable = false;
  let continuationDepth = 0;
  const openString: { kind: 'basic' | 'literal' | null } = { kind: null };

  for (const rawLine of lines) {
    if (continuationDepth > 0) {
      if (inMatchedTable) collected.push(rawLine);
      continuationDepth += scanLine(rawLine, openString).depthDelta;
      continue;
    }

    const scanned = scanLine(rawLine, openString);
    const header = parseTomlTableHeader(scanned.code);
    if (header) {
      inMatchedTable =
        header.length >= prefixPath.length &&
        prefixPath.every((segment, index) => header[index] === segment) &&
        !excludedChildren.includes(header[prefixPath.length] ?? '');
      if (inMatchedTable) {
        if (collected.length > 0) collected.push('');
        collected.push(rawLine.trimEnd());
      }
      continue;
    }
    // An array-of-tables header is still a section boundary even though MCP
    // declarations do not use that shape. Without this reset, a later
    // unrelated `[[plugins]]` block would be copied as if it belonged to the
    // preceding MCP server.
    if (/^\s*\[\[.*\]\]\s*$/.test(scanned.code)) {
      inMatchedTable = false;
      continue;
    }

    if (inMatchedTable) {
      collected.push(rawLine.trimEnd());
      continuationDepth = Math.max(0, scanned.depthDelta);
    }
  }

  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
  return collected.length > 0 ? `${collected.join('\n')}\n` : undefined;
}
