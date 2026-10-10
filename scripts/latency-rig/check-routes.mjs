#!/usr/bin/env node
/** Fail closed when an Expo route appears without an explicit cold-read budget. */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../apps/mobile/sources/app/', import.meta.url));
const budgetPath = new URL('./routes.json', import.meta.url);
const interactionsPath = new URL('./interactions.json', import.meta.url);

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]));
  return nested.flat();
}

export function routeForFile(file) {
  if (!file.endsWith('.tsx') || file.endsWith('.test.tsx')) return null;
  const parts = file.split('/');
  const last = parts.at(-1);
  if (last.startsWith('_') || last.startsWith('+')) return null;
  if (/^[A-Z]/.test(parts.at(-1))) return null;
  const path = parts.filter((part) => !/^\(.*\)$/.test(part))
    .join('/').replace(/\.tsx$/, '').replace(/(^|\/)index$/, '') || '/';
  return path.startsWith('/') ? path : `/${path}`;
}

export async function checkRoutes(actualFiles, routes) {
  const expected = actualFiles.map(routeForFile).filter(Boolean).sort();
  const observed = routes.map((route) => route.path).sort();
  const duplicate = observed.find((path, index) => path === observed[index - 1]);
  if (duplicate) throw new Error(`duplicate route budget: ${duplicate}`);
  const missing = expected.filter((path) => !observed.includes(path));
  const extra = observed.filter((path) => !expected.includes(path));
  if (missing.length || extra.length) throw new Error(`route budget drift: missing=${missing.join(',')} extra=${extra.join(',')}`);
  for (const route of routes) {
    if (!Number.isInteger(route.coldHttpMax) || !Number.isInteger(route.coldDepthMax) ||
        route.coldHttpMax < 0 || route.coldDepthMax < 0 ||
        route.coldDepthMax > route.coldHttpMax)
      throw new Error(`invalid cold request budget for ${route.path}`);
  }
  return expected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = (await files(root)).map((file) => relative(root, file).split(sep).join('/'));
  const routes = JSON.parse(await readFile(budgetPath, 'utf8'));
  const interactions = JSON.parse(await readFile(interactionsPath, 'utf8'));
  const checked = await checkRoutes(paths, routes);
  if (!Array.isArray(interactions) || interactions.length === 0 ||
      interactions.some((name) => typeof name !== 'string' || !name) ||
      new Set(interactions).size !== interactions.length)
    throw new Error('interaction matrix must contain distinct names');
  console.log(`Latency budgets cover ${checked.length} Expo routes and ${interactions.length} interactions.`);
}
