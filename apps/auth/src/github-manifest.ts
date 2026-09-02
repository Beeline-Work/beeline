import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * GitHub App manifest creation flow + configuration drift detection.
 *
 * The operator's hand-created GitHub App once shipped with `"events": []` —
 * webhook URL and secret were right, but GitHub delivered nothing, so the
 * repository-activity feed was silently dead. This module is the fix on two
 * halves:
 *
 * 1. MANIFEST CREATION — `buildAppManifest` preconfigures everything the
 *    product needs so a new App can be created by submitting ONE form instead
 *    of hand-assembling checkboxes (the served page lives in server.ts's
 *    `/auth/github/app-setup`). GitHub generates the webhook secret during the
 *    manifest conversion and returns it in the response.
 * 2. DRIFT DETECTION — `gitHubAppDrift` compares the LIVE app (GET /app)
 *    against the same required sets, and `formatGitHubAppDriftLine` renders
 *    one plain actionable line naming exactly what is missing plus the GitHub
 *    settings URL. Run at auth-service startup and on demand; this would have
 *    caught the empty-events gap immediately.
 *
 * The required permissions below are the owner-approved GitHub capability
 * contract for repository corners. A token is still restricted to the exact
 * Room repository, but receives this complete App grant without a per-token
 * downgrade:
 * - contents, pull_requests, issues, actions, workflows, discussions write
 * - checks and statuses read
 * - metadata read (required for every GitHub App)
 *
 * Administration, secrets, environments, and organization permissions are
 * deliberately absent. Keep this list pinned by the manifest tests: changing
 * it changes the approval request for every installed account.
 */

/** Repository activity and corner lifecycle event types consumed by the product. */
export const REQUIRED_GITHUB_APP_EVENTS = [
  'star',
  'issues',
  'pull_request',
  'push',
  'check_run',
  'check_suite',
  'status',
] as const;

export const REQUIRED_GITHUB_APP_PERMISSIONS: Readonly<Record<string, string>> = Object.freeze({
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  actions: 'write',
  workflows: 'write',
  discussions: 'write',
  metadata: 'read',
  checks: 'read',
  statuses: 'read',
});

export interface GitHubAppManifestInput {
  /** Display name of the App on github.com. */
  name: string;
  /** Externally reachable base origin of THIS auth service (e.g. https://usebeeline.app). */
  origin: string;
  /**
   * Where GitHub redirects after creation, carrying the one-time conversion
   * code (and any extra query such as the operator gate token).
   */
  redirectUrl: string;
}

export function buildAppManifest(input: GitHubAppManifestInput): Record<string, unknown> {
  return {
    name: input.name,
    url: input.origin,
    hook_attributes: {
      url: `${input.origin}/auth/github/webhook`,
      active: true,
    },
    redirect_url: input.redirectUrl,
    description: 'Beeline agent identity, repository access, and repository activity feed.',
    public: false,
    default_events: [...REQUIRED_GITHUB_APP_EVENTS],
    default_permissions: { ...REQUIRED_GITHUB_APP_PERMISSIONS },
  };
}

export interface GitHubAppManifestConversion {
  appId: number;
  slug: string;
  pem: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  htmlUrl?: string;
}

/**
 * Exchange a manifest-flow creation code for the full App credential set.
 * GitHub answers POST /app-manifests/{code}/conversions with HTTP 201 and an
 * App payload that includes `pem`, `client_id`, `client_secret`, and the
 * generated `webhook_secret`. The code is single-use; a repeat fails.
 */
export async function convertAppManifestCode(
  apiBaseUrl: string,
  code: string,
): Promise<GitHubAppManifestConversion> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'beeline-auth',
      },
      body: JSON.stringify({}),
    });
  } catch (error) {
    throw new Error(
      `GitHub manifest conversion request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status === 404) {
    throw new Error('GitHub rejected the conversion code (unknown or already used)');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`GitHub manifest conversion returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok || !body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`GitHub manifest conversion failed: HTTP ${response.status}`);
  }
  const record = body as Record<string, unknown>;
  const id = record.id;
  const slug = record.slug;
  const pem = record.pem;
  const clientId = record.client_id;
  const clientSecret = record.client_secret;
  const webhookSecret = record.webhook_secret;
  const htmlUrl = typeof record.html_url === 'string' ? record.html_url : undefined;
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof slug !== 'string' ||
    !slug ||
    typeof pem !== 'string' ||
    !pem.includes('PRIVATE KEY') ||
    typeof clientId !== 'string' ||
    !clientId ||
    typeof clientSecret !== 'string' ||
    !clientSecret ||
    typeof webhookSecret !== 'string' ||
    !webhookSecret
  ) {
    throw new Error('GitHub manifest conversion response is missing required credentials');
  }
  return {
    appId: id,
    slug,
    pem,
    clientId,
    clientSecret,
    webhookSecret,
    ...(htmlUrl ? { htmlUrl } : {}),
  };
}

/**
 * Copy-paste environment block in exactly the shape the auth service env
 * expects (BEELINE_GITHUB_* per github-config.ts). PEM newlines are escaped to
 * literal `\n` sequences, matching how github.ts unescapes the private key.
 * Callers render this for the operator ONCE; it must never be logged.
 */
export function appSetupEnvBlock(conversion: GitHubAppManifestConversion): string {
  return [
    `BEELINE_GITHUB_CLIENT_ID=${conversion.clientId}`,
    `BEELINE_GITHUB_CLIENT_SECRET=${conversion.clientSecret}`,
    `BEELINE_GITHUB_APP_ID=${conversion.appId}`,
    `BEELINE_GITHUB_APP_SLUG=${conversion.slug}`,
    `BEELINE_GITHUB_APP_PRIVATE_KEY=${conversion.pem.replace(/\n/g, '\\n')}`,
    `BEELINE_GITHUB_WEBHOOK_SECRET=${conversion.webhookSecret}`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

/** The subset of GET /app this comparison needs. */
export interface GitHubLiveAppConfig {
  slug: string;
  events?: unknown;
  permissions?: unknown;
}

export type GitHubAppDrift =
  | { ok: true }
  | {
      ok: false;
      missingEvents: string[];
      permissionProblems: Array<{ key: string; have: string; want: string }>;
    };

/** Compare a live GET /app answer against the required events + permissions. */
export function gitHubAppDrift(live: GitHubLiveAppConfig): GitHubAppDrift {
  const liveEvents = new Set(
    Array.isArray(live.events) ? live.events.filter((e): e is string => typeof e === 'string') : [],
  );
  const missingEvents = REQUIRED_GITHUB_APP_EVENTS.filter((event) => !liveEvents.has(event));
  const livePermissions =
    live.permissions && typeof live.permissions === 'object' && !Array.isArray(live.permissions)
      ? (live.permissions as Record<string, unknown>)
      : {};
  const permissionProblems = Object.entries(REQUIRED_GITHUB_APP_PERMISSIONS)
    .filter(([key, want]) => livePermissions[key] !== want)
    .map(([key, want]) => ({ key, have: String(livePermissions[key] ?? 'none'), want }));
  if (missingEvents.length === 0 && permissionProblems.length === 0) return { ok: true };
  return { ok: false, missingEvents, permissionProblems };
}

/** One plain actionable line naming exactly what is missing and where to fix it. */
export function formatGitHubAppDriftLine(drift: GitHubAppDrift, slug: string): string {
  if (drift.ok) return `[auth] GitHub App '${slug}' events and permissions match the required set.`;
  const settingsUrl = `https://github.com/settings/apps/${slug}/permissions`;
  const parts: string[] = [];
  if (drift.missingEvents.length > 0) {
    parts.push(`not subscribed to events: ${drift.missingEvents.join(', ')}`);
  }
  if (drift.permissionProblems.length > 0) {
    parts.push(
      `permissions below required: ${drift.permissionProblems
        .map((p) => `${p.key} (${p.have}, need ${p.want})`)
        .join(', ')}`,
    );
  }
  return `[auth] GitHub App configuration drift for '${slug}': ${parts.join('; ')}. Fix at ${settingsUrl}`;
}

/**
 * Best-effort startup drift probe. Never throws: a GitHub failure logs one
 * line and resolves, because an unreachable api.github.com must not take the
 * auth service down. Returns the drift result for callers that want it.
 */
export async function checkGitHubAppDriftBestEffort(
  app: { fetchApp(): Promise<GitHubLiveAppConfig> },
  log: (line: string) => void,
): Promise<GitHubAppDrift | undefined> {
  try {
    const live = await app.fetchApp();
    const drift = gitHubAppDrift(live);
    log(formatGitHubAppDriftLine(drift, live.slug));
    return drift;
  } catch (error) {
    log(
      `[auth] GitHub App drift check skipped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/** Constant-time shared-secret comparison (hash both sides, then compare). */
export function setupTokenMatches(candidate: unknown, expected: string): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0 || expected.length === 0) {
    return false;
  }
  const left = createHash('sha256').update(candidate).digest();
  const right = createHash('sha256').update(expected).digest();
  return left.length === right.length && timingSafeEqual(left, right);
}
