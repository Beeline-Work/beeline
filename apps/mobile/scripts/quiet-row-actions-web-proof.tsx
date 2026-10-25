import React from 'react';
// @ts-expect-error Browser proof dependencies have no local declarations.
import { createRoot } from 'react-dom/client';
import { QuietRowActionsScene } from './quiet-row-actions-scene';
createRoot(document.getElementById('root')!).render(<QuietRowActionsScene />);
