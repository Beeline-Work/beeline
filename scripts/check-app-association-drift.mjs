#!/usr/bin/env node

import {
  diffAssociationDocuments,
  formatAssociationDiff,
  readLiveAssociations,
  readRepositoryAssociations,
  validateRequiredAssociations,
} from './app-associations.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function checkLiveAssociationDrift({ fetchImpl = fetch } = {}) {
  const repository = await readRepositoryAssociations();
  const requiredErrors = validateRequiredAssociations(repository);
  if (requiredErrors.length > 0) throw new Error(requiredErrors.join('\n'));

  const live = await readLiveAssociations({ fetchImpl });
  const reports = [];
  for (const kind of Object.keys(repository)) {
    const report = formatAssociationDiff(
      kind,
      diffAssociationDocuments(kind, repository[kind], live[kind]),
    );
    if (report) reports.push(report);
  }
  if (reports.length > 0) throw new Error(reports.join('\n\n'));
  return 'Live Apple and Android app associations match the repository.';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkLiveAssociationDrift()
    .then((message) => console.log(message))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
