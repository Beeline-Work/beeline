import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export type PushPermissionStatus = 'unsupported' | 'granted' | 'denied' | 'undetermined';

export interface PushPermissionInfo {
    status: PushPermissionStatus;
    granted: boolean;
    canAskAgain: boolean;
}

export async function getPushPermissionInfo(): Promise<PushPermissionInfo> {
    if (Platform.OS === 'web') {
        if (typeof window === 'undefined' || !window.isSecureContext ||
            !('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window))
            return { status: 'unsupported', granted: false, canAskAgain: false };
        return {
            status: Notification.permission === 'granted' ? 'granted' :
                Notification.permission === 'denied' ? 'denied' : 'undetermined',
            granted: Notification.permission === 'granted',
            canAskAgain: Notification.permission !== 'denied',
        };
    }

    try {
        const permission = await Notifications.getPermissionsAsync();
        const status: PushPermissionStatus =
            permission.status === 'granted' ||
            permission.status === 'denied' ||
            permission.status === 'undetermined'
                ? permission.status
                : 'undetermined';
        return {
            status,
            granted: permission.granted === true || status === 'granted',
            canAskAgain: permission.canAskAgain === true,
        };
    } catch (error) {
        console.log('Failed to get push notification permissions:', error);
        return { status: 'undetermined', granted: false, canAskAgain: false };
    }
}
