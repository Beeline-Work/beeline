import { expect, it, vi } from 'vitest';
import { ConnectorIntentIndex } from './connector-intent-index.js';
import type { McpRegistryClient } from './mcp-registry.js';
import type { ComposioApps } from './composio-apps.js';

it('ranks intent and website matches, merges sources, and reuses the built catalog', async () => {
  const registry = { catalog: vi.fn(async () => [{ name: 'com.twilio/mcp', version: '1', title: 'Twilio',
    websiteUrl: 'https://twilio.com', remotes: [], packages: [], secretInputNames: [], description: 'Send SMS' }]) };
  const composio = { catalog: vi.fn(async () => [{ slug: 'twilio', name: 'Twilio', description: 'SMS messaging' }]) };
  const index = new ConnectorIntentIndex(registry as unknown as McpRegistryClient, composio as unknown as ComposioApps);
  await index.refresh();
  const status = new Map([['link', 'not-connected'], ['twilio', 'connected']] as const);
  expect(index.search('add a card', status).matches[0]).toMatchObject({ key: 'link' });
  expect(index.search('Stripe Link', status).matches[0]).toMatchObject({ service: 'Link' });
  expect(index.search('https://link.com', status).matches[0]).toMatchObject({ key: 'link' });
  const sms = index.search('send texts', status);
  expect(sms.matches).toEqual([expect.objectContaining({ key: 'twilio', status: 'connected', source: 'composio' })]);
  await index.refresh();
  index.search('Stripe Link', status);
  expect(registry.catalog).toHaveBeenCalledOnce();
  expect(composio.catalog).toHaveBeenCalledOnce();
});

it('keeps private Squire service metadata out of another owner’s search', async () => {
  const registry = { catalog: vi.fn(async () => []) };
  const index = new ConnectorIntentIndex(registry as unknown as McpRegistryClient);
  await index.refresh();
  const personal = [{ key: 'privateapp', service: 'privateapp', name: 'Private app', source: 'squire' as const }];
  expect(index.search('privateapp', new Map([['privateapp', 'broken']]), personal).matches[0]?.status).toBe('broken');
  expect(index.search('privateapp', new Map()).matches).toEqual([]);
});

it('keeps first-party discovery available when external catalog refresh fails', async () => {
  const registry = { catalog: vi.fn(async () => { throw new Error('down'); }) };
  const index = new ConnectorIntentIndex(registry as unknown as McpRegistryClient);
  await index.refresh();
  expect(index.search('add a card', new Map())).toMatchObject({
    matches: [expect.objectContaining({ key: 'link' })], unavailableSources: ['registry'],
  });
});
