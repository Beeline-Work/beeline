import React from 'react';
import { AppMark } from './AppMark';

export { serviceFaviconUrl } from './AppMark';

export function ServiceMark({
  company,
  domain,
  testID,
}: {
  company: string;
  domain?: string;
  testID?: string;
}) {
  return <AppMark name={company} domain={domain} testID={testID} />;
}
