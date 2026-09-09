import { Platform } from 'react-native';
import { getDeviceType } from 'react-native-device-info';

const deviceType = getDeviceType();

export function isRunningOnMac(): boolean {
    if (Platform.OS !== 'ios') {
        return false;
    }
    
    if (deviceType === 'Desktop') {
        return true;
    }
    
    // Check if running on Mac Catalyst
    // @ts-ignore - isPad is not in the type definitions but exists at runtime
    return Platform.isPad && Platform.Version && typeof Platform.Version === 'string' && 
           Platform.Version.includes('Mac');
}

// Platforms that draw desktop chrome. Width is a separate question — ask
// `useIsDesktop()` in `utils/responsive` when the layout depends on both.
export function isDesktopPlatform(): boolean {
    return Platform.OS === 'web' || isRunningOnMac();
}
