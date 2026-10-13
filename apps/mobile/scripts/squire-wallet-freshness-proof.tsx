import React from 'react';
// @ts-expect-error render proof uses installed react-dom without production declarations.
import { createRoot } from 'react-dom/client';
import Wallet from '../sources/app/(app)/beeline/settings/workbench/wallet';
import Connection from '../sources/app/(app)/beeline/settings/workbench/connection';
import Squire from '../sources/app/(app)/beeline/settings/workbench/service';
import { HullActionSheet, HullActionSheetCancel, HullActionSheetRow } from '../sources/components/buzz/HullActionSheet';
import { View } from 'react-native';
import { getWalletSource, getWorkbenchSource } from './squire-wallet-freshness-fixtures';
(globalThis as any).__freshnessSources = { wallet: getWalletSource(), workbench: getWorkbenchSource() };
const params = new URLSearchParams(window.location.search);
const before = params.get('before') === '1';
const screen = params.get('screen');
const noop = () => {};
createRoot(document.getElementById('root')!).render(screen === 'wallet' ? <Wallet /> : screen === 'connection' ? <Connection /> :
  <View style={{ flex: 1 }}><View style={{ flex: 1, opacity: 0.35 }}><Squire /></View>
    <HullActionSheet title="Trusty Squire"><HullActionSheetRow label={before ? 'Manage in Trusty Squire' : 'Disconnect'} destructive={!before} onPress={noop} />
      <HullActionSheetCancel onPress={noop} /></HullActionSheet></View>);
