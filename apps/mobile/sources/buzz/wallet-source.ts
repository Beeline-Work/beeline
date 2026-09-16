import type {
  WalletChainView,
  WalletHistoryResult,
  WalletSendOutcome,
  WalletView,
} from '@beeline/api-contract/wallet';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

/**
 * The Wallet data source. The DEFAULT is the real monolith source: every
 * method resolves through the same authenticated phone operations the rest
 * of the app uses, and the server scopes every read to the session's viewer
 * — a wallet belongs to whoever created it. Tests install the mock
 * (`wallet-source.mock.ts`) through `setWalletSource()`; the screens never
 * read either implementation directly.
 */
export interface WalletSource {
  /** One tap creates the wallet bound to the signed-in identity. */
  createWallet(input: { workspaceId: string }): Promise<WalletView>;
  readWallet(input: { workspaceId: string }): Promise<WalletView>;
  sendFromWallet(input: {
    workspaceId: string;
    chain: WalletChainView['id'];
    asset: string;
    amount: string;
    to: string;
  }): Promise<WalletSendOutcome>;
  /** Re-grant delegated signing; renewal is USER-ONLY (C: delegation ladder probe). */
  grantDelegation(input: { workspaceId: string }): Promise<{ expiresAt: number }>;
  /** The viewer's own transaction history. Oldest first, as the server
   *  stores it; screens render newest first by reversing. */
  readHistory(input: { workspaceId: string; limit?: number }): Promise<WalletHistoryResult>;
}

type WalletViewDto = WalletView;

/** Chain-view passthrough: the server projection is already paint-ready. */

export class MonolithWalletSource implements WalletSource {
  async createWallet(input: { workspaceId: string }): Promise<WalletView> {
    return monolithPhoneOperation('createWallet', { workspaceId: input.workspaceId });
  }

  async readWallet(input: { workspaceId: string }): Promise<WalletView> {
    return monolithPhoneOperation('readWallet', { workspaceId: input.workspaceId });
  }

  async sendFromWallet(input: {
    workspaceId: string;
    chain: WalletChainView['id'];
    asset: string;
    amount: string;
    to: string;
  }): Promise<WalletSendOutcome> {
    return monolithPhoneOperation('sendFromWallet', input);
  }

  async grantDelegation(input: { workspaceId: string }): Promise<{ expiresAt: number }> {
    return monolithPhoneOperation('grantWalletDelegation', {
      workspaceId: input.workspaceId,
    });
  }

  async readHistory(input: {
    workspaceId: string;
    limit?: number;
  }): Promise<WalletHistoryResult> {
    return monolithPhoneOperation('readWalletHistory', {
      workspaceId: input.workspaceId,
      limit: input.limit,
    });
  }
}

let activeSource: WalletSource = new MonolithWalletSource();

export function getWalletSource(): WalletSource {
  return activeSource;
}

export function setWalletSource(source: WalletSource): void {
  activeSource = source;
}

/** Chain-picker label for the fee column: "no fee", "~$0.01", or "no balance". */
export function chainFeeLabel(chain: WalletChainView): string {
  if (!chain.hasBalance) return 'no balance';
  if (chain.sponsored || chain.feeUsd === null) return 'no fee';
  return `~${chain.feeUsd}`;
}
