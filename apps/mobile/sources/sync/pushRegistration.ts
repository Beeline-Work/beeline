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
        return { status: 'unsupported', granted: false, canAskAgain: false };
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
