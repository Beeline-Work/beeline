/** Server-owned Connectors presentation. Targets retain existing item authority. */
export type CompanyLogo =
  | { readonly kind: 'image'; readonly uri: string; readonly plate: 'light' | 'dark' }
  | { readonly kind: 'website' | 'monogram' };
export type ConnectionTarget =
  | { readonly kind: 'key'; readonly connectionId: string }
  | { readonly kind: 'app'; readonly appId: string }
  | { readonly kind: 'connector'; readonly connectorId: string }
  | { readonly kind: 'wallet' | 'link' };
export type CompanySuggestion = {
  readonly appKey: string; readonly appName: string; readonly name: string; readonly purpose: string;
  readonly providerId: string; readonly providerName: string; readonly domain?: string;
  readonly logo: CompanyLogo;
  readonly registryServerName?: string; readonly registryVersion?: string;
  readonly preferredRoute?: 'composio' | 'squire-api';
  readonly alternativeRoutes?: readonly ('composio' | 'squire-api')[];
  readonly flow: 'app' | 'squire' | 'tailscale' | 'wallet' | 'link';
};
/** Server-owned Connectors attention. The phone renders this; it does not reclassify. */
export type ConnectorViewState = 'connected' | 'connect' | 'error';
export type CompanyItem = {
  readonly id: string; readonly title: string; readonly subtitle: string;
  readonly kind: 'key' | 'login' | 'connection'; readonly target: ConnectionTarget;
  readonly state?: ConnectorViewState; readonly status?: string; readonly attention?: boolean;
};
export type WorkbenchCompany = {
  readonly roomsClientId?: string;
  readonly id: string; readonly name: string; readonly domain?: string;
  readonly kind: 'company' | 'sign-in-service' | 'other'; readonly logo: CompanyLogo;
  readonly section: 'attention' | 'signin' | 'apps' | 'keys';
  readonly subtitle: string; readonly state?: ConnectorViewState; readonly status?: string; readonly attention?: string;
  readonly items: readonly CompanyItem[];
  readonly machines: readonly { readonly id: string; readonly name: string;
    readonly online: boolean; readonly status: 'connected' | 'error' | 'not-added'; readonly error?: string; readonly signedInAs?: string; readonly reconnecting?: boolean; readonly statusText?: string }[];
  readonly alsoAvailable: readonly CompanySuggestion[];
  /** Verified MCP offered on the service page; does not count as an installed app. */
  readonly mcp?: CompanySuggestion;
};
export type WorkbenchCompanyIndex = {
  readonly version: 1; readonly rows: readonly WorkbenchCompany[];
  readonly suggestions: readonly CompanySuggestion[]; readonly hasConnections: boolean;
  readonly summary: { readonly value: string; readonly attention?: string };
};
