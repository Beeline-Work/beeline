import assert from 'node:assert/strict';
import test from 'node:test';

import {
  diffAssociationDocuments,
  readRepositoryAssociations,
  validateRequiredAssociations,
} from './app-associations.mjs';
import { checkLiveAssociationDrift } from './check-app-association-drift.mjs';

test('committed associations retain every production dependency', async () => {
  assert.deepEqual(validateRequiredAssociations(await readRepositoryAssociations()), []);
});

test('missing /review/* fails the production dependency contract', async () => {
  const documents = structuredClone(await readRepositoryAssociations());
  documents.apple.applinks.details[0].paths = documents.apple.applinks.details[0].paths.filter(
    (path) => path !== '/review/*',
  );
  assert.deepEqual(validateRequiredAssociations(documents), [
    'Apple association is missing required path /review/* for 89KT3SWYAF.app.usebeeline.mobile',
  ]);
});

test('missing legacy Android package fails the production dependency contract', async () => {
  const documents = structuredClone(await readRepositoryAssociations());
  documents.android = documents.android.filter(
    (entry) => entry.target.package_name !== 'app.usebeeline.mobile',
  );
  assert.deepEqual(validateRequiredAssociations(documents), [
    'Android association is missing required package app.usebeeline.mobile',
  ]);
});

test('live drift check reports the exact mismatched entries and fails', async () => {
  const repository = await readRepositoryAssociations();
  const live = structuredClone(repository);
  live.apple.applinks.details[0].paths = live.apple.applinks.details[0].paths.filter(
    (path) => path !== '/review/*',
  );
  live.android = live.android.filter(
    (entry) => entry.target.package_name !== 'app.usebeeline.mobile',
  );
  const responses = [live.apple, live.android];
  const fetchImpl = async () => new Response(JSON.stringify(responses.shift()));

  await assert.rejects(checkLiveAssociationDrift({ fetchImpl }), (error) => {
    assert.match(error.message, /repository only: appID=.* path=\/review\/\*/);
    assert.match(error.message, /repository only: package=app\.usebeeline\.mobile /);
    return true;
  });
});

test('entry comparison is order-independent', async () => {
  const repository = await readRepositoryAssociations();
  const reordered = structuredClone(repository.android).reverse();
  for (const entry of reordered) entry.target.sha256_cert_fingerprints.reverse();
  assert.deepEqual(diffAssociationDocuments('android', repository.android, reordered), {
    repositoryOnly: [],
    liveOnly: [],
  });
});
