import type { CompanySuggestion, WorkbenchCompany } from '@beeline/api-contract/workbench';
import type { WorkbenchView } from '@/buzz/workbench';
/** Synthetic server answers. Tests must never recreate company grouping on the phone. */
export function companyRow(id: string, name = id, section: WorkbenchCompany['section'] = 'keys'): WorkbenchCompany {
  return { id, name, domain: `${id}.example`, kind: 'company', section, logo: { kind: 'image', uri: `https://server.test/v1/company-logos/${id}`, plate: 'dark' },
    subtitle: '1 key', items: [{ id: `${id}-key`, title: 'Production API', subtitle: `${id}.example`, kind: 'key', target: { kind: 'key', connectionId: `${id}-key` } }], machines: [], alsoAvailable: [] };
}
export function companyOption(id: string, name: string, flow: CompanySuggestion['flow'] = 'app'): CompanySuggestion {
  return { appKey: id, appName: name, name, purpose: `Connect to ${name}`, providerId: id, providerName: name,
    domain: `${id}.example`, logo: { kind: 'image', uri: `https://server.test/v1/company-logos/${id}`, plate: 'dark' }, flow };
}
export function companyWorkbench(rows: readonly WorkbenchCompany[] = [companyRow('vercel', 'Vercel')],
  suggestions: readonly CompanySuggestion[] = []): WorkbenchView {
  return { helpers: [], connectors: [], connections: [], apps: [], companies: { version: 1, rows, suggestions,
    hasConnections: rows.some(r => r.items.length || r.machines.some(m => m.status !== 'not-added')),
    summary: { value: `${rows.length} connections` } } };
}
export function squireRow(status: 'connected' | 'not-added' = 'connected'): WorkbenchCompany {
  return { ...companyRow('squire-signin', 'Trusty Squire', 'signin'), kind: 'sign-in-service', subtitle: '1 computer',
    status: status === 'connected' ? 'Ready' : 'Not added', items: [], machines: [{ id: 'machine-one', name: 'Laptop', online: true, status }] };
}
