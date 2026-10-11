import React from 'react';
// @ts-expect-error Standalone preview uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import Schedule from '../../apps/mobile/sources/app/(app)/beeline/settings/schedule';
import Workflow from '../../apps/mobile/sources/app/(app)/beeline/workflow';

const page = new URLSearchParams(location.search).get('page');
document.body.dataset.page = page === 'workflow' ? 'workflow' : 'schedule';
createRoot(document.getElementById('root')!).render(page === 'workflow' ? <Workflow /> : <Schedule />);
