import React from 'react';
import { PageHeader } from './PageHeader';

/** Approved app-board treatment, rendered by the shared page header. */
export function AppPageHeader({ eyebrow, title, onBack, backLabel, testID }: {
  eyebrow: string; title: string; onBack: () => void; backLabel: string; testID?: string;
}) {
  return <PageHeader appBoard eyebrow={eyebrow} title={title} onBack={onBack}
    backAccessibilityLabel={backLabel} testID={testID} />;
}
