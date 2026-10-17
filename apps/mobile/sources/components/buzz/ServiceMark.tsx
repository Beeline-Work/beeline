import type { CompanyLogo } from '@beeline/api-contract/workbench';
import React from 'react';
import { AppMark } from './AppMark';

export { serviceFaviconUrl } from './AppMark';

export function ServiceMark({
  company,
  mark,
  domain,
  testID,
}: {
  company: string;
  mark?: CompanyLogo;
  domain?: string;
  testID?: string;
}) {
  return <AppMark name={company} mark={mark} domain={domain} testID={testID} />;
}
