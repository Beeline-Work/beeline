import {
    createContext,
    createElement,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { AppState, Platform } from 'react-native';
import { usePathname } from 'expo-router';
import * as Updates from 'expo-updates';
import { trackOtaUpdateAvailable, trackOtaUpdateApplied } from '@/track';
import { isTauri } from '@/utils/isTauri';

type PendingOtaUpdate = {
    ota_version?: string;
    ota_runtime_version?: string;
};

type PendingDesktopUpdate = {
    version: string;
    downloadAndInstall: () => Promise<void>;
};

type UpdateContextValue = {
    updateAvailable: boolean;
    promptVisible: boolean;
    isChecking: boolean;
    checkForUpdates: () => Promise<void>;
    reloadApp: () => Promise<void>;
    dismissPrompt: () => void;
};

const UpdateContext = createContext<UpdateContextValue | null>(null);

/**
 * These routes can contain unsent text or work the user is actively reviewing.
 * Everywhere else is an idle navigation surface where swapping bundles is safe.
 */
export function isUpdateBusyPath(pathname: string): boolean {
    return [
        /^\/session(?:\/|$)/,
        /^\/(?:buzz|beeline)\/(?:chat|corners)(?:\/|$)/,
        /^\/new(?:\/|$)/,
        /^\/text-selection(?:\/|$)/,
    ].some((pattern) => pattern.test(pathname));
}

function updateIdentity(manifest: { id?: string; runtimeVersion?: string | null }): PendingOtaUpdate {
    return {
        ota_version: manifest.id,
        ota_runtime_version: manifest.runtimeVersion ?? undefined,
    };
}

/**
 * Owns OTA state once, above every authenticated and unauthenticated route.
 * Consumers such as UpdateBanner only render that state; they never start
 * independent checks or downloads.
 */
export function UpdateProvider({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const pathnameRef = useRef(pathname);
    const checkingRef = useRef(false);
    const applyingRef = useRef(false);
    const desktopInstallCompleteRef = useRef(false);
    const desktopAutoApplyAttemptedRef = useRef(false);
    const pendingUpdateRef = useRef<PendingOtaUpdate | null>(null);
    const pendingDesktopUpdateRef = useRef<PendingDesktopUpdate | null>(null);
    const [updateAvailable, setUpdateAvailable] = useState(false);
    const [promptVisible, setPromptVisible] = useState(false);
    const [isChecking, setIsChecking] = useState(false);

    pathnameRef.current = pathname;

    const applyUpdate = useCallback(async (pendingUpdate?: PendingOtaUpdate): Promise<boolean> => {
        const desktopUpdate = pendingDesktopUpdateRef.current;
        if (desktopUpdate) {
            if (applyingRef.current) return true;
            applyingRef.current = true;
            try {
                if (!desktopInstallCompleteRef.current) {
                    await desktopUpdate.downloadAndInstall();
                    desktopInstallCompleteRef.current = true;
                }
                // The Windows NSIS installer exits and restarts the process itself.
                // macOS and Linux return after installation and need this call.
                const { relaunch } = await import('@tauri-apps/plugin-process');
                await relaunch();
                return true;
            } catch (error) {
                console.error('Error applying desktop update:', error);
                return false;
            } finally {
                applyingRef.current = false;
            }
        }

        trackOtaUpdateApplied(pendingUpdate ?? pendingUpdateRef.current ?? undefined);
        if (Platform.OS === 'web') {
            window.location.reload();
            return true;
        }

        try {
            await Updates.reloadAsync();
            return true;
        } catch (error) {
            console.error('Error reloading app:', error);
            return false;
        }
    }, []);

    const reloadApp = useCallback(async () => {
        const applied = await applyUpdate();
        if (!applied && pendingDesktopUpdateRef.current) setPromptVisible(true);
    }, [applyUpdate]);

    const checkForUpdates = useCallback(async () => {
        if (__DEV__ || checkingRef.current) {
            return;
        }

        checkingRef.current = true;
        setIsChecking(true);

        try {
            if (isTauri()) {
                // Preview/dev shells share this source but are not signed for
                // the production updater channel.
                if (process.env.EXPO_PUBLIC_BEELINE_DESKTOP_UPDATES !== '1') return;
                const { check } = await import('@tauri-apps/plugin-updater');
                const update = await check();
                if (!update) return;
                if (pendingDesktopUpdateRef.current?.version !== update.version) {
                    desktopInstallCompleteRef.current = false;
                    desktopAutoApplyAttemptedRef.current = false;
                }
                pendingDesktopUpdateRef.current = update;
                setUpdateAvailable(true);
                // The path effect below is the single owner of automatic
                // installation. Keeping it out of this async check avoids a
                // state-render race that could install the same update twice.
                setPromptVisible(isUpdateBusyPath(pathnameRef.current));
                return;
            }

            const update = await Updates.checkForUpdateAsync();
            if (!update.isAvailable) {
                return;
            }

            const fetched = await Updates.fetchUpdateAsync();
            if (!fetched.isNew) {
                return;
            }

            const pendingUpdate = updateIdentity(fetched.manifest);
            pendingUpdateRef.current = pendingUpdate;
            trackOtaUpdateAvailable(pendingUpdate);
            setUpdateAvailable(true);

            if (!isUpdateBusyPath(pathnameRef.current)) {
                const reloadStarted = await applyUpdate(pendingUpdate);
                if (!reloadStarted) {
                    // A native reload failure must leave an actionable way out.
                    setPromptVisible(true);
                }
                return;
            }

            setPromptVisible(true);
        } catch (error) {
            console.error('Error checking for updates:', error);
        } finally {
            checkingRef.current = false;
            setIsChecking(false);
        }
    }, [applyUpdate]);

    useEffect(() => {
        if (!updateAvailable || !pendingDesktopUpdateRef.current || isUpdateBusyPath(pathname)
            || desktopAutoApplyAttemptedRef.current) return;
        desktopAutoApplyAttemptedRef.current = true;
        setPromptVisible(false);
        void applyUpdate().then((applied) => {
            if (!applied) setPromptVisible(true);
        });
    }, [applyUpdate, pathname, updateAvailable]);

    useEffect(() => {
        const subscription = AppState.addEventListener('change', (nextState) => {
            if (nextState === 'active') {
                void checkForUpdates();
            }
        });

        void checkForUpdates();
        return () => subscription.remove();
    }, [checkForUpdates]);

    const value = useMemo<UpdateContextValue>(() => ({
        updateAvailable,
        promptVisible,
        isChecking,
        checkForUpdates,
        reloadApp,
        dismissPrompt: () => setPromptVisible(false),
    }), [checkForUpdates, isChecking, promptVisible, reloadApp, updateAvailable]);

    return createElement(UpdateContext.Provider, { value }, children);
}

export function useUpdates(): UpdateContextValue {
    const context = useContext(UpdateContext);
    if (!context) {
        throw new Error('useUpdates must be used within UpdateProvider');
    }
    return context;
}
