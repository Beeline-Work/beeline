import type { WorkbenchCompanyIndex } from '@beeline/api-contract/workbench';
const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object');
const string = (v: unknown): v is string => typeof v === 'string';
const optionalString = (v: unknown) => v === undefined || string(v);
const optionalBoolean = (v: unknown) => v === undefined || typeof v === 'boolean';
const list = (v: unknown, guard: (v: unknown) => boolean) => Array.isArray(v) && v.every(guard);
function logo(v: unknown): boolean {
  return record(v) && (v.kind === 'website' || v.kind === 'monogram' || (v.kind === 'image' && string(v.uri) && ['light', 'dark'].includes(String(v.plate))));
}
function suggestion(v: unknown): boolean {
  return record(v) && ['appKey', 'appName', 'name', 'purpose', 'providerId', 'providerName'].every(k => string(v[k])) && optionalString(v.domain) && logo(v.logo)
    && ['app', 'squire', 'tailscale', 'wallet', 'link'].includes(String(v.flow)) && optionalString(v.registryServerName) && optionalString(v.registryVersion)
    && (v.preferredRoute === undefined || ['composio', 'squire-api'].includes(String(v.preferredRoute)))
    && (v.alternativeRoutes === undefined || list(v.alternativeRoutes, r => r === 'composio' || r === 'squire-api'));
}
function target(v: unknown): boolean {
  return record(v) && (v.kind === 'wallet' || v.kind === 'link' || (v.kind === 'key' && string(v.connectionId))
    || (v.kind === 'app' && string(v.appId)) || (v.kind === 'connector' && string(v.connectorId)));
}
/** Validate the server-owned nested presentation before accepting it into durable storage. */
export function isWorkbenchCompanyIndex(v: unknown): v is WorkbenchCompanyIndex {
  return record(v) && v.version === 1 && typeof v.hasConnections === 'boolean' && record(v.summary) && string(v.summary.value) && optionalString(v.summary.attention)
    && list(v.suggestions, suggestion) && list(v.rows, r => record(r) && string(r.id) && string(r.name) && string(r.subtitle) && optionalString(r.domain)
      && ['company', 'sign-in-service', 'other'].includes(String(r.kind)) && ['attention', 'signin', 'apps', 'keys'].includes(String(r.section)) && logo(r.logo)
      && optionalString(r.status) && optionalString(r.attention) && list(r.alsoAvailable, suggestion)
      && list(r.items, i => record(i) && string(i.id) && string(i.title) && string(i.subtitle) && ['key', 'login', 'connection'].includes(String(i.kind))
        && target(i.target) && optionalString(i.status) && optionalBoolean(i.attention))
      && list(r.machines, m => record(m) && string(m.id) && string(m.name) && typeof m.online === 'boolean'
        && ['connected', 'error', 'not-added'].includes(String(m.status)) && optionalString(m.error)));
}
