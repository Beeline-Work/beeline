import { Redirect, useLocalSearchParams, type Href } from 'expo-router';

/**
 * The wallet opens straight from Connectors, so this old status page owns no
 * screen of its own: links saved before the change land on the wallet.
 */
export default function WalletServiceRedirect() {
  const { workspaceId } = useLocalSearchParams<{ workspaceId?: string }>();
  return <Redirect href={{ pathname: '/beeline/settings/workbench/wallet', params: workspaceId ? { workspaceId } : {} } as Href} />;
}
