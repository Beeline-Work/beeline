/**
 * A deliberately small, versioned UI language for agent-authored Corner Apps.
 * The phone renders these primitives natively; definitions never carry code,
 * markup, URLs, styles, or executable expressions.
 */
export const CORNER_APP_SLUG = /^[a-z][a-z0-9-]{0,31}$/;
export const CORNER_APP_MAX_BLOCKS = 40;
export const CORNER_APP_MAX_FIELDS = 24;

export type CornerAppBlock =
  | { readonly type: 'heading'; readonly text: string }
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'fields';
      readonly items: readonly { readonly label: string; readonly value: string }[];
    }
  | { readonly type: 'notice'; readonly text: string; readonly tone?: 'neutral' | 'warning' }
  | { readonly type: 'action'; readonly label: string; readonly prompt: string };

export type CornerAppDefinition = {
  readonly version: 1;
  readonly slug: string;
  readonly title: string;
  readonly description?: string;
  /** Plain slash token, without the slash. Unique within one corner. */
  readonly command: string;
  readonly blocks: readonly CornerAppBlock[];
};

export type CornerAppView = CornerAppDefinition & {
  /** Present when the installed app is linked to an agent that can receive actions. */
  readonly authorId?: string;
  readonly authorName: string;
  readonly authorHandle?: string;
  readonly revision: number;
  readonly updatedAt: number;
};

/** An installed app advertises human UI and agent capability separately.
 * Broker capability names are opaque here: a later permission grant decides
 * whether either side may invoke them. */
export type CornerAppManifest = {
  readonly version: 1;
  readonly slug: string;
  readonly title: string;
  readonly description?: string;
  readonly developer: string;
  readonly humanUi?:
    | {
        readonly kind: 'native';
        readonly definition: CornerAppDefinition;
        readonly embedsChat?: boolean;
      }
    | { readonly kind: 'broker'; readonly capability: string; readonly embedsChat?: boolean };
  readonly agent?: { readonly kind: 'broker'; readonly capability: string };
  readonly permissions?: readonly string[];
};

export type CornerAppInstallationView = {
  readonly id: string;
  readonly manifest: CornerAppManifest;
};

export type CornerAppBindingView = CornerAppInstallationView & {
  readonly instanceId: string;
};

const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/** Runtime boundary shared by daemon writes and tolerant phone reads. */
export function readCornerAppDefinition(value: unknown): CornerAppDefinition | null {
  if (!value || typeof value !== 'object') return null;
  const app = value as Record<string, unknown>;
  if (
    app.version !== 1 ||
    typeof app.slug !== 'string' ||
    !CORNER_APP_SLUG.test(app.slug) ||
    !text(app.title, 80) ||
    (app.description !== undefined && !text(app.description, 240)) ||
    typeof app.command !== 'string' ||
    !CORNER_APP_SLUG.test(app.command) ||
    !Array.isArray(app.blocks) ||
    app.blocks.length > CORNER_APP_MAX_BLOCKS
  ) {
    return null;
  }
  const blocks: CornerAppBlock[] = [];
  for (const candidate of app.blocks) {
    if (!candidate || typeof candidate !== 'object') return null;
    const block = candidate as Record<string, unknown>;
    if (block.type === 'heading' && text(block.text, 120)) {
      blocks.push({ type: 'heading', text: block.text });
    } else if (block.type === 'text' && text(block.text, 4000)) {
      blocks.push({ type: 'text', text: block.text });
    } else if (
      block.type === 'notice' &&
      text(block.text, 1000) &&
      (block.tone === undefined || block.tone === 'neutral' || block.tone === 'warning')
    ) {
      blocks.push({
        type: 'notice',
        text: block.text,
        ...(block.tone ? { tone: block.tone } : {}),
      });
    } else if (block.type === 'action' && text(block.label, 80) && text(block.prompt, 2000)) {
      blocks.push({ type: 'action', label: block.label, prompt: block.prompt });
    } else if (
      block.type === 'fields' &&
      Array.isArray(block.items) &&
      block.items.length > 0 &&
      block.items.length <= CORNER_APP_MAX_FIELDS
    ) {
      const items = block.items.map((candidate) => {
        if (!candidate || typeof candidate !== 'object') return null;
        const item = candidate as Record<string, unknown>;
        return text(item.label, 80) && text(item.value, 500)
          ? { label: item.label, value: item.value }
          : null;
      });
      if (items.some((item) => item === null)) return null;
      blocks.push({ type: 'fields', items: items as { label: string; value: string }[] });
    } else {
      return null;
    }
  }
  return {
    version: 1,
    slug: app.slug,
    title: app.title.trim(),
    ...(typeof app.description === 'string' ? { description: app.description.trim() } : {}),
    command: app.command,
    blocks,
  };
}

const capability = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9._:-]{0,127}$/.test(value);

export function readCornerAppManifest(value: unknown): CornerAppManifest | null {
  if (!value || typeof value !== 'object') return null;
  const manifest = value as Record<string, unknown>;
  if (
    manifest.version !== 1 ||
    typeof manifest.slug !== 'string' ||
    !CORNER_APP_SLUG.test(manifest.slug) ||
    !text(manifest.title, 80) ||
    !text(manifest.developer, 120) ||
    (manifest.description !== undefined && !text(manifest.description, 240))
  )
    return null;
  const human = manifest.humanUi as Record<string, unknown> | undefined;
  let humanUi: CornerAppManifest['humanUi'];
  if (human?.kind === 'native') {
    const definition = readCornerAppDefinition(human.definition);
    if (!definition || definition.slug !== manifest.slug) return null;
    humanUi = {
      kind: 'native',
      definition,
      ...(human.embedsChat === true ? { embedsChat: true } : {}),
    };
  } else if (human?.kind === 'broker' && capability(human.capability)) {
    humanUi = {
      kind: 'broker',
      capability: human.capability,
      ...(human.embedsChat === true ? { embedsChat: true } : {}),
    };
  } else if (human !== undefined) return null;
  const agent = manifest.agent as Record<string, unknown> | null | undefined;
  if (
    agent === null ||
    (agent !== undefined && (agent.kind !== 'broker' || !capability(agent.capability)))
  )
    return null;
  const permissions = manifest.permissions;
  if (
    permissions !== undefined &&
    (!Array.isArray(permissions) || permissions.length > 32 || !permissions.every(capability))
  )
    return null;
  return {
    version: 1,
    slug: manifest.slug,
    title: manifest.title.trim(),
    ...(typeof manifest.description === 'string'
      ? { description: manifest.description.trim() }
      : {}),
    developer: manifest.developer.trim(),
    ...(humanUi ? { humanUi } : {}),
    ...(agent ? { agent: { kind: 'broker', capability: agent.capability as string } } : {}),
    ...(permissions ? { permissions: permissions as string[] } : {}),
  };
}
