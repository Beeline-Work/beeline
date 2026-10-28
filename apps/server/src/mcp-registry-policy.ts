import { appIdentity, registryServerDomain } from '@beeline/api-contract/workbench';
import { COMPANY_APPS, COMPANY_REGISTRY, type CompanyProvider } from './company-registry.js';

/** Resolve product aliases (including Google apps) to the company that owns them. */
export function registryAppCompany(app: string): CompanyProvider | undefined {
  const identity = appIdentity(app);
  if (!identity) return undefined;
  const catalog = COMPANY_APPS.find(entry => entry.appKey === identity.key);
  return COMPANY_REGISTRY.find(company =>
    company.hosts.some(host => appIdentity(host)?.key === identity.key)
    || catalog && company.hosts.some(host => catalog.domain === host || catalog.domain.endsWith(`.${host}`)));
}

/** Publisher namespaces are authority; titles and websites never authorize a route. */
export function isAppRegistryPublisher(serverName: string, app: string): boolean {
  const publisher = registryServerDomain(serverName);
  if (!publisher) return false;
  const company = registryAppCompany(app);
  if (company) return company.hosts.includes(publisher);
  return publisher === appIdentity(app)?.domain;
}
