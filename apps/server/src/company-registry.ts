import { getDomain } from 'tldts';

export type CompanyProvider = { id: string; name: string; domain?: string; hosts: readonly string[] };
export const COMPANY_REGISTRY: readonly CompanyProvider[] = [
  {"id": "fly", "name": "Fly.io", "domain": "fly.io", "hosts": ["fly.io", "machines.dev"]},
  {"id": "sentry", "name": "Sentry", "domain": "sentry.io", "hosts": ["sentry.io"]},
  {"id": "google", "name": "Google", "domain": "google.com", "hosts": ["google.com", "googleapis.com", "youtube.com", "gstatic.com", "gmail.com", "googleusercontent.com"]},
  {"id": "cloudflare", "name": "Cloudflare", "domain": "cloudflare.com", "hosts": ["cloudflare.com"]},
  {"id": "fish", "name": "Fish Audio", "domain": "fish.audio", "hosts": ["fish.audio"]},
  {"id": "beeline", "name": "Beeline", "domain": "usebeeline.app", "hosts": ["usebeeline.app"]},
  {"id": "github", "name": "GitHub", "domain": "github.com", "hosts": ["github.com", "githubusercontent.com"]},
  {"id": "stripe", "name": "Stripe", "domain": "stripe.com", "hosts": ["stripe.com"]},
  {"id": "slack", "name": "Slack", "domain": "slack.com", "hosts": ["slack.com"]},
  {"id": "linear", "name": "Linear", "domain": "linear.app", "hosts": ["linear.app"]},
  {"id": "squire", "name": "Trusty Squire", "domain": "trustysquire.ai", "hosts": ["trustysquire.ai"]},
  {"id": "notion", "name": "Notion", "domain": "notion.so", "hosts": ["notion.so", "notion.com"]},
  {"id": "meta", "name": "Meta", "domain": "instagram.com", "hosts": ["instagram.com", "facebook.com"]},
  {"id": "tiktok", "name": "TikTok", "domain": "tiktok.com", "hosts": ["tiktok.com", "tiktokapis.com"]},
  {"id": "fal", "name": "fal", "domain": "fal.ai", "hosts": ["fal.ai", "fal.run"]},
  {"id": "apple", "name": "Apple", "domain": "apple.com", "hosts": ["apple.com"]},
  {"id": "expo", "name": "Expo", "domain": "expo.dev", "hosts": ["expo.dev"]},
  {"id": "neon", "name": "Neon", "domain": "neon.tech", "hosts": ["neon.tech"]},
  {"id": "openrouter", "name": "OpenRouter", "domain": "openrouter.ai", "hosts": ["openrouter.ai"]},
  {"id": "coinbase", "name": "Coinbase", "domain": "coinbase.com", "hosts": ["coinbase.com"]},
  {"id": "twilio", "name": "Twilio", "domain": "twilio.com", "hosts": ["twilio.com"]},
  {"id": "browserstack", "name": "BrowserStack", "domain": "browserstack.com", "hosts": ["browserstack.com"]},
  {"id": "resend", "name": "Resend", "domain": "resend.com", "hosts": ["resend.com"]},
  {"id": "composio", "name": "Composio", "domain": "composio.dev", "hosts": ["composio.dev"]},
  {"id": "x", "name": "X", "domain": "x.com", "hosts": ["x.com", "twitter.com"]},
  {"id": "shopify", "name": "Shopify", "domain": "shopify.com", "hosts": ["shopify.com", "myshopify.com"]},
  {"id": "railway", "name": "Railway", "domain": "railway.com", "hosts": ["railway.com", "railway.app"]},
  {"id": "elevenlabs", "name": "ElevenLabs", "domain": "elevenlabs.io", "hosts": ["elevenlabs.io", "elevenlabs.com"]},
  {"id": "convex", "name": "Convex", "domain": "convex.dev", "hosts": ["convex.dev"]},
  {"id": "metamask", "name": "MetaMask", "domain": "metamask.io", "hosts": ["metamask.io"]},
  {"id": "hetzner", "name": "Hetzner", "domain": "hetzner.com", "hosts": ["hetzner.com"]},
  {"id": "amazon", "name": "Amazon", "domain": "amazon.co.jp", "hosts": ["amazon.co.jp", "amazon.com"]},
  {"id": "muji", "name": "MUJI", "domain": "muji.com", "hosts": ["muji.com", "muji.net"]},
  {"id": "askul", "name": "ASKUL", "domain": "askul.co.jp", "hosts": ["askul.co.jp"]},
  {"id": "dsers", "name": "DSers", "domain": "dsers.com", "hosts": ["dsers.com"]},
  {"id": "tailscale", "name": "Tailscale", "domain": "tailscale.com", "hosts": ["tailscale.com"]},
  {"id": "link", "name": "Link", "domain": "link.com", "hosts": ["link.com"]},
  {"id": "hubspot", "name": "HubSpot", "domain": "hubspot.com", "hosts": ["hubspot.com"]},
  {"id": "airtable", "name": "Airtable", "domain": "airtable.com", "hosts": ["airtable.com"]},
  {"id": "asana", "name": "Asana", "domain": "asana.com", "hosts": ["asana.com"]},
  {"id": "atlassian", "name": "Atlassian", "domain": "atlassian.com", "hosts": ["atlassian.com"]},
  {"id": "supabase", "name": "Supabase", "domain": "supabase.com", "hosts": ["supabase.com"]},
];
/** One catalog for search, empty accounts and Also available. Never a client fallback list. */
export const COMPANY_APPS = [
  {"appKey": "trusty-squire", "name": "Trusty Squire", "domain": "trustysquire.ai", "purpose": "Signs up and signs in for your agents."},
  {"appKey": "gmail", "name": "Gmail", "domain": "mail.google.com", "purpose": "Read and send email."},
  {"appKey": "googlecalendar", "name": "Google Calendar", "domain": "calendar.google.com", "purpose": "Plan meetings and manage your calendar."},
  {"appKey": "googledrive", "name": "Google Drive", "domain": "drive.google.com", "purpose": "Find and organize your files."},
  {"appKey": "googlesheets", "name": "Google Sheets", "domain": "sheets.google.com", "purpose": "Read and update spreadsheets."},
  {"appKey": "googledocs", "name": "Google Docs", "domain": "docs.google.com", "purpose": "Write and edit documents."},
  {"appKey": "youtube", "name": "YouTube", "domain": "youtube.com", "purpose": "Manage YouTube videos and your channel."},
  {"appKey": "instagram", "name": "Instagram", "domain": "instagram.com", "purpose": "Publish and manage Instagram posts."},
  {"appKey": "slack", "name": "Slack", "domain": "slack.com", "purpose": "Work with your team’s conversations."},
  {"appKey": "linear", "name": "Linear", "domain": "linear.app", "purpose": "Track issues and project work."},
  {"appKey": "notion", "name": "Notion", "domain": "notion.so", "purpose": "Read and update workspace pages."},
  {"appKey": "hubspot", "name": "HubSpot", "domain": "hubspot.com", "purpose": "Manage customer relationships."},
  {"appKey": "airtable", "name": "Airtable", "domain": "airtable.com", "purpose": "Work with your team’s records."},
  {"appKey": "asana", "name": "Asana", "domain": "asana.com", "purpose": "Organize tasks and projects."},
  {"appKey": "jira", "name": "Jira", "domain": "atlassian.com", "purpose": "Manage issues and delivery."},
  {"appKey": "supabase", "name": "Supabase", "domain": "supabase.com", "purpose": "Manage your project’s database."},
  {"appKey": "link", "name": "Link", "domain": "link.com", "purpose": "Approve purchases for your agents."},
  {"appKey": "tiktok", "name": "TikTok", "domain": "tiktok.com", "purpose": "Manage videos and your account."},
  {"appKey": "tailscale", "name": "Tailscale", "domain": "tailscale.com", "purpose": "Reach devices on your private network."},
  {"appKey": "wallet", "name": "Coinbase wallet", "domain": "coinbase.com", "purpose": "Manage your agent wallet."},
  {"appKey": "github", "name": "GitHub", "domain": "github.com", "purpose": "Work with repositories and issues."},
  {"appKey": "sentry", "name": "Sentry", "domain": "sentry.io", "purpose": "Investigate errors in your apps."},
] as const;

export const COMPANY_MARK_IDS = new Set(["fly","sentry","google","cloudflare","fish","beeline","github","stripe","linear","squire","notion","meta","tiktok","apple","expo","neon","openrouter","coinbase","resend","x","shopify","railway","elevenlabs","convex","hetzner","tailscale","hubspot","airtable","asana","atlassian","supabase"]);

export function companyHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const input = value.trim().replace(/^\*\./, '');
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.username || url.password || url.port || !getDomain(hostname) || /^[\d.]+$/.test(hostname)) return undefined;
    return hostname;
  } catch { return undefined; }
}
const aliases: readonly [string, RegExp][] = [
  ['sentry', /^sentry(?:$|[- _])/], ['fly', /^fly(?:$|[.\- _])/],
  ['google', /^(?:google(?:$|[.\- _])|firebase(?:$|[- _]))/],
  ['cloudflare', /^cloudflare(?:$|[- _])/], ['openrouter', /^openrouter(?:$|[- _])/],
  ['squire', /^(?:trusty[- _]?squire|trustysquire)(?:$|[- _])/],
  ['apple', /^(?:apple(?:$|[- _])|fastlane-match$)/], ['beeline', /^beeline(?:$|[- _])/],
  ['browserstack', /^browserstack(?:$|[- _])/], ['railway', /^railway$/],
  ['elevenlabs', /^elevenlabs(?:\.com|\.io)?$/], ['convex', /^convex$/],
  ['metamask', /^metamask$/], ['shopify', /^shopify$/], ['muji', /^muji$/],
  ['stripe', /^stripe(?:$|[- _])/], ['github', /^github(?:$|[- _])/],
];
const OTHER: CompanyProvider = { id: 'other', name: 'Other', hosts: [] };
function providerForHost(host: string): CompanyProvider {
  const known = COMPANY_REGISTRY.find(p => p.hosts.some(d => host === d || host.endsWith(`.${d}`)));
  if (known) return known;
  const domain = getDomain(host, { allowPrivateDomains: true });
  return domain ? { id: domain, name: domain, domain, hosts: [domain] } : OTHER;
}
/** Usage evidence precedes structured service/key metadata. Display labels are never inputs. */
export function resolveCompany(input: {
  domain?: string; allowedHosts?: readonly string[]; loginHosts?: readonly string[];
  service?: string | null; keyName?: string; appKey?: string;
}): CompanyProvider {
  const host = companyHost(input.domain) ?? input.allowedHosts?.map(companyHost).find(Boolean)
    ?? input.loginHosts?.map(companyHost).find(Boolean);
  if (host) return providerForHost(host);
  const app = COMPANY_APPS.find(a => a.appKey === input.appKey);
  if (app) return providerForHost(app.domain);
  const service = input.service?.trim().toLowerCase() ?? '';
  const known = COMPANY_REGISTRY.find(p => p.id === service || p.name.toLowerCase() === service);
  if (known) return known;
  const match = aliases.find(([, pattern]) => pattern.test(service));
  if (match) return COMPANY_REGISTRY.find(p => p.id === match[0])!;
  const domain = companyHost(service);
  if (domain) return providerForHost(domain);
  const key = input.keyName?.toLowerCase().replace(/_/g, '-') ?? '';
  const namedKey = COMPANY_REGISTRY.find(p => p.id.length >= 3 && (key === p.id || key.startsWith(`${p.id}-`)));
  if (namedKey) return namedKey;
  const keyMatch = aliases.find(([, pattern]) => pattern.test(key));
  return keyMatch ? COMPANY_REGISTRY.find(p => p.id === keyMatch[0])! : OTHER;
}
