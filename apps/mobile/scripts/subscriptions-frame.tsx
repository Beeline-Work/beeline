import React from 'react';
// @ts-expect-error Standalone browser frame uses installed react-dom.
import { createRoot } from 'react-dom/client';
import ScheduledWork from '../sources/app/(app)/beeline/settings/schedules';

createRoot(document.getElementById('root')!).render(<ScheduledWork />);
