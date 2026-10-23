import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import Subscription from '../../sources/app/(app)/beeline/settings/subscription';
createRoot(document.getElementById('root')!).render(<Subscription />);
