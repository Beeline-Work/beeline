import React from 'react';
// @ts-expect-error Standalone proof harness uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import SharedUiLibraryProof from './shared-ui-library-proof';

createRoot(document.getElementById('root')!).render(<SharedUiLibraryProof />);
