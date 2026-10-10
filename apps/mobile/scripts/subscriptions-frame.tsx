import React from 'react';
// @ts-expect-error Standalone browser frame uses installed react-dom.
import { createRoot } from 'react-dom/client';
import ScheduledWork from '../sources/app/(app)/beeline/settings/schedules';
import Subscription from '../sources/app/(app)/beeline/settings/subscription';

const Screen = new URLSearchParams(location.search).get('page') === 'subscription' ? Subscription : ScheduledWork;
createRoot(document.getElementById('root')!).render(<Screen />);
