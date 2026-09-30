import React from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import AgentClassesSettings from '../sources/app/(app)/beeline/settings/agent-classes';

/** Paints Workspace settings → Agent classes from the render script's fixture. */
createRoot(document.getElementById('root')!).render(<AgentClassesSettings />);
