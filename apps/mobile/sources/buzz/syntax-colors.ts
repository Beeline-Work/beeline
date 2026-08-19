/**
 * Muted, low-saturation syntax highlighting palette for code blocks.
 *
 * This is one of the two sanctioned colour exceptions to Grok Mono Hull's
 * zero-chroma rule (see DESIGN.md).  Colours are deliberately subdued so
 * the mono-slab reading experience is enhanced, not replaced.
 *
 * Tokens that don't match any category stay on the base text colour.
 */
export const syntaxColors = {
  /** `import`, `export`, `return`, `if`, `for`, `while`, `class`, `function`, `const`, `let`, `var`, `async`, `await` — muted yellow-amber */
  keyword: '#cca760',
  /** String literals, template literals, heredocs — muted green-amber */
  string: '#9eb87c',
  /** Numbers, booleans — muted cool grey with a slight blue cast */
  number: '#8aa0b8',
  /** Comments (`//`, `/*`, `#`, `<!--`) — lowest luminance */
  comment: '#5c5c5c',
  /** Type annotations, type/interface/class keywords — muted teal */
  type: '#7fadad',
  /** Built-in names: `console`, `this`, `super`, `undefined`, `null`, `true`, `false` */
  builtin: '#b08fa3',
  /** Operator-like punctuation: `=>`, `:`, `;`, `,`, `(`, `)`, `{`, `}`, `[`, `]` */
  punctuation: '#8a8f96',
  /** Function/method call names — plain text colour with a subtle tint */
  function: '#c7b89a',
  /** Tag names in markup languages (HTML, JSX) — muted brown */
  tag: '#b09070',
  /** Attribute names in markup — muted sand */
  attrName: '#9ea07a',
  /** Attribute values in markup — same as strings */
  attrValue: '#9eb87c',
} as const;

export type SyntaxToken = keyof typeof syntaxColors;