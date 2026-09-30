import React from 'react';
// @ts-expect-error Browser proof uses installed react-dom.
import { createRoot } from 'react-dom/client';
import AppDetailScreen from '../sources/app/(app)/beeline/settings/workbench/app';
import ConnectAppScreen from '../sources/app/(app)/beeline/settings/workbench/connect-app';

const Screen = new URLSearchParams(location.search).get('page') === 'list'
  ? ConnectAppScreen : AppDetailScreen;
createRoot(document.getElementById('root')!).render(<Screen />);
