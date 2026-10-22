import React from 'react';
// @ts-expect-error Standalone proof uses the installed react-dom.
import { createRoot } from 'react-dom/client';
import { HeaderAlignmentProof } from './screen';
createRoot(document.getElementById('root')!).render(<HeaderAlignmentProof desktop={innerWidth >= 768} />);
