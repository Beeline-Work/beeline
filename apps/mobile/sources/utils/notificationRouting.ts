import type { Router } from 'expo-router';

function getObjectValue(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return (value as Record<string, unknown>)[key];
}

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function normalizeNotificationData(data: unknown): unknown {
    if (typeof data === 'string') {
        return parseJson(data);
    }
    return data;
}

/** Merge-approval pushes name the child explicitly, so they cannot fall back to its parent Room. */
export function getBuzzChannelIdFromNotificationData(data: unknown): string | null {
    const normalizedData = normalizeNotificationData(data);
    if (!normalizedData || typeof normalizedData !== 'object' || Array.isArray(normalizedData)) {
        return null;
    }
    const type = getObjectValue(normalizedData, 'type');
    const cornerId = getObjectValue(normalizedData, 'cornerId');
    if (type === 'merge-approval-request' && typeof cornerId === 'string' && cornerId.trim()) {
        return cornerId;
    }
    const channelId = getObjectValue(normalizedData, 'channelId');
    return typeof channelId === 'string' && channelId.trim() ? channelId : null;
}

function hasLegacySessionUrl(url: string): boolean {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
        return false;
    }

    const match = trimmedUrl.match(/(?:^|\/)session\/([^/?#]+)/);
    if (!match) {
        return false;
    }

    const encodedSessionId = match[1];
    const sessionId = (() => {
        try {
            return decodeURIComponent(encodedSessionId);
        } catch {
            return encodedSessionId;
        }
    })();

    const trimmedSessionId = sessionId.trim();
    return Boolean(trimmedSessionId);
}

/** Detect a retired Happy-session push so it can fall back to the Room list. */
export function isLegacySessionNotificationData(data: unknown): boolean {
    const normalizedData = normalizeNotificationData(data);
    if (!normalizedData || typeof normalizedData !== 'object' || Array.isArray(normalizedData)) {
        return false;
    }

    const url = getObjectValue(normalizedData, 'url');
    if (typeof url === 'string' && hasLegacySessionUrl(url)) {
        return true;
    }

    const sessionId = getObjectValue(normalizedData, 'sessionId');
    if (typeof sessionId !== 'string') {
        return false;
    }
    return Boolean(sessionId.trim());
}

export function isLegacySessionNotificationResponse(response: unknown): boolean {
    const contentData = getObjectValue(getObjectValue(getObjectValue(response, 'notification'), 'request'), 'content');
    return isLegacySessionNotificationData(getObjectValue(contentData, 'data'));
}

/**
 * Bring a notification's Room to the front without creating another copy.
 * The response id also invalidates the retained screen's transcript backfill.
 */
export function navigateToBuzzChannelFromNotification(
    router: Pick<Router, 'navigate'>,
    channelId: string,
    notificationResponseId: string,
): void {
    router.navigate(
        {
            pathname: '/buzz/chat/[channelId]',
            params: { channelId, notificationResponseId },
        },
        { dangerouslySingular: true },
    );
}
