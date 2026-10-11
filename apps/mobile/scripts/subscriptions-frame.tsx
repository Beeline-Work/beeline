import React from 'react';
// @ts-expect-error Standalone browser frame uses installed react-dom.
import { createRoot } from 'react-dom/client';
import ScheduledWork from '../sources/app/(app)/beeline/settings/schedules';
import Subscription from '../sources/app/(app)/beeline/settings/subscription';
import Schedule from '../sources/app/(app)/beeline/settings/schedule';
import Workflow from '../sources/app/(app)/beeline/workflow';

const page = new URLSearchParams(location.search).get('page') ?? '';
const Screen = page === 'workflow-from-subscription' ? Workflow
  : page.startsWith('schedule-') ? Schedule
  : page.startsWith('subscription-') || page === 'stop-confirm' ? Subscription : ScheduledWork;
createRoot(document.getElementById('root')!).render(<Screen />);
