import { describe, expect, it } from 'vitest';
import { isAppRegistryPublisher } from './mcp-registry-policy.js';

describe('Registry publisher authority', () => {
  it.each(['youtube', 'gmail', 'googlecalendar', 'googledrive', 'googlesheets', 'googledocs'])
    ('protects the Google product %s with its company hosts', app => {
      expect(isAppRegistryPublisher(`click.myagents/${app}`, app)).toBe(false);
      expect(isAppRegistryPublisher(`com.google/${app}`, app)).toBe(true);
    });

  it.each([
    ['com.stripe/mcp', 'Stripe'],
    ['app.linear/linear', 'Linear'],
    ['com.notion/mcp', 'Notion'],
    ['com.slack/mcp', 'Slack'],
    ['com.atlassian/mcp', 'jira'],
  ])('allows official publisher %s for %s', (server, app) => {
    expect(isAppRegistryPublisher(server, app)).toBe(true);
    expect(isAppRegistryPublisher('click.myagents/mcp', app)).toBe(false);
  });

  it('requires an unknown app to name its publisher domain', () => {
    expect(isAppRegistryPublisher('org.example/echo', 'https://example.org')).toBe(true);
    expect(isAppRegistryPublisher('org.example/echo', 'https://echo.test')).toBe(false);
    expect(isAppRegistryPublisher('org.example/echo', 'Echo')).toBe(false);
  });

  it('does not accept lookalike hosts or a GitHub publisher as a company domain', () => {
    expect(isAppRegistryPublisher('net.stripe/mcp', 'Stripe')).toBe(false);
    expect(isAppRegistryPublisher('io.github.stripe/mcp', 'Stripe')).toBe(false);
    expect(isAppRegistryPublisher('click.myagents.youtube/mcp', 'YouTube')).toBe(false);
  });
});
