import { Dimensions, Platform } from 'react-native';
import { useWindowDimensions } from 'react-native';
import { useMemo } from 'react';
import { calculateDeviceDimensions, determineDeviceType, calculateHeaderHeight } from './deviceCalculations';
import { isDesktopPlatform, isRunningOnMac } from './platform';
import { getLayoutClass, type LayoutClass } from './layoutClass';

// Re-export calculation functions for use in other components
export { calculateDeviceDimensions, determineDeviceType, calculateHeaderHeight };
export { getLayoutClass, LAYOUT_BREAKPOINTS, type LayoutClass } from './layoutClass';

// Get header height based on platform, device type, and orientation (wrapper for backward compatibility)
export function getHeaderHeight(isLandscape: boolean, deviceType: 'phone' | 'tablet'): number {
    return calculateHeaderHeight({
        platform: Platform.OS,
        isLandscape,
        // @ts-ignore - isPad is not in the type definitions but exists at runtime on iOS
        isPad: Platform.OS === 'ios' ? Platform.isPad : undefined,
        deviceType: Platform.OS === 'android' ? deviceType : undefined,
        isMacCatalyst: isRunningOnMac()
    });
}

// Device type detection based on screen size and aspect ratio
export function getDeviceType(): 'phone' | 'tablet' {
    const { width, height } = Dimensions.get('screen');

    const dimensions = calculateDeviceDimensions({
        widthPoints: width,
        heightPoints: height,
        pointsPerInch: Platform.OS === 'ios' ? 163 : 160
    });

    return determineDeviceType({
        diagonalInches: dimensions.diagonalInches,
        platform: Platform.OS,
        // @ts-ignore - isPad is not in the type definitions but exists at runtime on iOS
        isPad: Platform.OS === 'ios' ? Platform.isPad : false
    });
}

// Hook to get device type (reactive to dimension changes)
export function useDeviceType(): 'phone' | 'tablet' {
    const { width, height } = useWindowDimensions();
    
    return useMemo(() => {
        const dimensions = calculateDeviceDimensions({
            widthPoints: width,
            heightPoints: height,
            pointsPerInch: Platform.OS === 'ios' ? 163 : 160
        });

        return determineDeviceType({
            diagonalInches: dimensions.diagonalInches,
            platform: Platform.OS,
            // @ts-ignore - isPad is not in the type definitions but exists at runtime on iOS
            isPad: Platform.OS === 'ios' ? Platform.isPad : false
        });
    }, [width, height]);
}

// Window-size classes follow the live layout width, including split-screen and
// resized desktop windows.
export function useLayoutClass(): LayoutClass {
    const { width } = useWindowDimensions();
    const deviceType = useDeviceType();

    // On web and Mac the "device" is a resizable window, so its physical
    // diagonal says nothing about the layout — width alone decides. A handheld
    // keeps the device check, which is what holds a phone in landscape (wider
    // than the `regular` threshold) at compact.
    return getLayoutClass(width, isDesktopPlatform() ? undefined : deviceType);
}

// Hook to detect if the current layout has room for the persistent sidebar.
export function useIsTablet(): boolean {
    return useLayoutClass() !== 'compact';
}

// Desktop chrome needs a desktop platform *and* a window with room for it; a
// narrow browser window gets the single-column treatment instead.
export function useIsDesktop(): boolean {
    const layoutClass = useLayoutClass();
    return isDesktopPlatform() && layoutClass !== 'compact';
}

// Hook to detect landscape orientation
export function useIsLandscape(): boolean {
    const { width, height } = useWindowDimensions();
    return width > height;
}

// Hook to get header height based on platform, device type, and orientation
export function useHeaderHeight(): number {
    const isLandscape = useIsLandscape();
    const deviceType = useDeviceType();
    
    return useMemo(() => {
        return calculateHeaderHeight({
            platform: Platform.OS,
            isLandscape,
            // @ts-ignore - isPad is not in the type definitions but exists at runtime on iOS
            isPad: Platform.OS === 'ios' ? Platform.isPad : undefined,
            deviceType: Platform.OS === 'android' ? deviceType : undefined,
            isMacCatalyst: isRunningOnMac()
        });
    }, [isLandscape, deviceType]);
}
