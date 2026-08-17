import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
    getSessionRouteFromNotificationData,
    getSessionRouteFromNotificationResponse,
    getBuzzChannelIdFromNotificationData,
    navigateToBuzzChannelFromNotification,
} from './notificationRouting';

const buzzChatSource = readFileSync(
    new URL('../app/(app)/buzz/chat/[channelId].tsx', import.meta.url),
    'utf8',
);

describe('getSessionRouteFromNotificationData', () => {
    it('returns a session route when sessionId exists', () => {
        expect(getSessionRouteFromNotificationData({ sessionId: 'session-123' })).toBe('/session/session-123');
    });

    it('encodes session ids that contain spaces', () => {
        expect(getSessionRouteFromNotificationData({ sessionId: 'session 123' })).toBe('/session/session%20123');
    });

    it('returns null when sessionId is missing', () => {
        expect(getSessionRouteFromNotificationData({ kind: 'done' })).toBeNull();
    });

    it('returns null for empty session ids', () => {
        expect(getSessionRouteFromNotificationData({ sessionId: '   ' })).toBeNull();
    });

    it('uses a session url when present', () => {
        expect(getSessionRouteFromNotificationData({ url: '/session/session-123' })).toBe('/session/session-123');
    });
});

describe('getSessionRouteFromNotificationResponse', () => {
    it('reads the route from content data', () => {
        expect(getSessionRouteFromNotificationResponse({
            notification: {
                request: {
                    content: {
                        data: { sessionId: 'session-123' }
                    }
                }
            }
        })).toBe('/session/session-123');
    });

    it('returns null when content data is missing', () => {
        expect(getSessionRouteFromNotificationResponse({
            notification: {
                request: {
                    content: {}
                }
            }
        })).toBeNull();
    });
});

describe('getBuzzChannelIdFromNotificationData', () => {
    it('routes merge approval notifications to their corner instead of a parent Room', () => {
        expect(getBuzzChannelIdFromNotificationData({
            channelId: 'parent-room',
            cornerId: 'review-corner',
            type: 'merge-approval-request',
        })).toBe('review-corner');
    });

    it('keeps ordinary channel activity on its channel', () => {
        expect(getBuzzChannelIdFromNotificationData({
            channelId: 'room-123',
            type: 'channel-activity',
        })).toBe('room-123');
    });
});

describe('navigateToBuzzChannelFromNotification', () => {
    it('reuses the room route and refreshes it for each notification response', () => {
        const navigate = vi.fn();

        navigateToBuzzChannelFromNotification(
            { navigate },
            'room-123',
            'notification-456',
        );

        expect(navigate).toHaveBeenCalledWith(
            {
                pathname: '/buzz/chat/[channelId]',
                params: {
                    channelId: 'room-123',
                    notificationResponseId: 'notification-456',
                },
            },
            { dangerouslySingular: true },
        );
    });

    it('uses the notification response id to invalidate the retained room backfill', () => {
        expect(buzzChatSource).toContain('const { channelId, notificationResponseId }');
        // The hydration effect must re-run when a notification re-opens the
        // same channel. Assert that dependency, not the whole literal list —
        // the rest of the list is free to change with the effect's internals.
        const hydrationDeps = buzzChatSource.match(
            /\}, \[decodedId, notificationResponseId[^\]]*\]\);/,
        );
        expect(hydrationDeps, 'room hydration effect must depend on notificationResponseId')
            .not.toBeNull();
    });
});
