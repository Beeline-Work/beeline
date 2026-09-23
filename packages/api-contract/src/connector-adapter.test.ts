import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_ADAPTER_DENIED,
  SQUIRE_CONNECTOR_ADAPTER,
  YOUTUBE_CONNECTOR_ADAPTER,
  adaptedConnectorKinds,
  connectorAdapter,
  connectorRequesterRole,
} from './connector-adapter.js';

describe('connector adapters', () => {
  it('registers only Squire and YouTube', () => {
    expect(adaptedConnectorKinds()).toEqual(['trusty-squire', 'google-youtube']);
    expect(connectorAdapter('trusty-squire')).toBe(SQUIRE_CONNECTOR_ADAPTER);
    expect(connectorAdapter('google-youtube')).toBe(YOUTUBE_CONNECTOR_ADAPTER);
    expect(connectorAdapter('google-gmail')).toBeUndefined();
    expect(connectorAdapter('tailscale')).toBeUndefined();
  });

  it('names the viewer owner only when the ids match', () => {
    expect(connectorRequesterRole('human-a', 'human-a')).toBe('owner');
    expect(connectorRequesterRole('human-b', 'human-a')).toBe('other');
  });

  it('lets the Squire owner connect, reconnect, disconnect, and revoke grants', () => {
    for (const action of SQUIRE_CONNECTOR_ADAPTER.actions) {
      expect(SQUIRE_CONNECTOR_ADAPTER.authorize(action, 'owner')).toEqual({ allowed: true });
    }
  });

  it('refuses another requester every Squire mutation with the Workbench denial', () => {
    for (const action of SQUIRE_CONNECTOR_ADAPTER.actions) {
      expect(SQUIRE_CONNECTOR_ADAPTER.authorize(action, 'other')).toEqual({
        allowed: false,
        reason: CONNECTOR_ADAPTER_DENIED,
      });
    }
  });

  it('lets the YouTube owner connect, reconnect, and disconnect, never revoke grants', () => {
    expect(YOUTUBE_CONNECTOR_ADAPTER.authorize('connect', 'owner')).toEqual({ allowed: true });
    expect(YOUTUBE_CONNECTOR_ADAPTER.authorize('reconnect', 'owner')).toEqual({ allowed: true });
    expect(YOUTUBE_CONNECTOR_ADAPTER.authorize('disconnect', 'owner')).toEqual({ allowed: true });
    expect(YOUTUBE_CONNECTOR_ADAPTER.authorize('revoke-grants', 'owner')).toEqual({
      allowed: false,
      reason: CONNECTOR_ADAPTER_DENIED,
    });
    expect(YOUTUBE_CONNECTOR_ADAPTER.authorize('disconnect', 'other')).toEqual({
      allowed: false,
      reason: CONNECTOR_ADAPTER_DENIED,
    });
  });

  it('offers Squire Workbench controls from status, including vault revoke when connected', () => {
    expect(SQUIRE_CONNECTOR_ADAPTER.workbenchActions(undefined)).toEqual(['connect']);
    expect(SQUIRE_CONNECTOR_ADAPTER.workbenchActions('disconnected')).toEqual(['connect']);
    expect(SQUIRE_CONNECTOR_ADAPTER.workbenchActions('installing')).toEqual(['disconnect']);
    expect(SQUIRE_CONNECTOR_ADAPTER.workbenchActions('connected')).toEqual([
      'reconnect',
      'disconnect',
      'revoke-grants',
    ]);
    expect(SQUIRE_CONNECTOR_ADAPTER.workbenchActions('error')).toEqual([
      'connect',
      'reconnect',
      'disconnect',
    ]);
  });

  it('offers YouTube Workbench controls without vault revoke', () => {
    expect(YOUTUBE_CONNECTOR_ADAPTER.workbenchActions(undefined)).toEqual(['connect']);
    expect(YOUTUBE_CONNECTOR_ADAPTER.workbenchActions('connected')).toEqual([
      'reconnect',
      'disconnect',
    ]);
    expect(YOUTUBE_CONNECTOR_ADAPTER.workbenchActions('connected')).not.toContain('revoke-grants');
  });

  it('derives helper lifecycle from status: Squire install/uninstall, YouTube grant refresh', () => {
    expect(SQUIRE_CONNECTOR_ADAPTER.assignmentKinds('installing')).toEqual(['install']);
    expect(SQUIRE_CONNECTOR_ADAPTER.assignmentKinds('disconnected')).toEqual(['uninstall']);
    expect(SQUIRE_CONNECTOR_ADAPTER.assignmentKinds('connected')).toEqual([]);
    expect(YOUTUBE_CONNECTOR_ADAPTER.assignmentKinds('installing')).toEqual(['install']);
    expect(YOUTUBE_CONNECTOR_ADAPTER.assignmentKinds('disconnected')).toEqual(['uninstall']);
    expect(YOUTUBE_CONNECTOR_ADAPTER.assignmentKinds('connected')).toEqual(['refresh-google-grant']);
  });
});
