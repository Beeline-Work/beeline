import * as Updates from 'expo-updates';

type PendingOtaUpdate = { ota_version?: string; ota_runtime_version?: string };
function updateIdentity(manifest: { id?: string; runtimeVersion?: string | null }): PendingOtaUpdate {
    return {
        ota_version: manifest.id,
        ota_runtime_version: manifest.runtimeVersion ?? undefined,
    };
}

type NativeUpdateResult = { available: false; downloadFailed?: boolean } | { available: true; isNew: boolean; identity: { ota_version?: string; ota_runtime_version?: string } };
let nativeFlight: Promise<NativeUpdateResult> | undefined;
let nativeStage: 'available' | 'downloaded' | undefined;
const nativeObservers = new Set<(stage: 'available' | 'downloaded') => void>();
/** Settings and the automatic owner share this exact SDK flight. */
export function checkNativeUpdate(observer?: (stage: 'available' | 'downloaded') => void): Promise<NativeUpdateResult> {
    if (!nativeFlight) {
        nativeStage = undefined;
        nativeFlight = (async () => {
            const update = await Updates.checkForUpdateAsync();
            if (!update.isAvailable) return { available: false as const };
            nativeStage = 'available'; for (const receive of nativeObservers) receive(nativeStage);
            const fetched = await Updates.fetchUpdateAsync();
            if (!fetched.isNew && !fetched.isRollBackToEmbedded) return { available: false as const, downloadFailed: true };
            const manifest = fetched.manifest as { id?: string; runtimeVersion?: string | null } | undefined;
            if (manifest?.runtimeVersion && Updates.runtimeVersion && manifest.runtimeVersion !== Updates.runtimeVersion)
                throw new Error('Update runtime is incompatible');
            nativeStage = 'downloaded'; for (const receive of nativeObservers) receive(nativeStage);
            return { available: true as const, isNew: fetched.isNew, identity: updateIdentity(manifest ?? {}) };
        })().finally(() => { nativeFlight = undefined; nativeStage = undefined; });
    }
    if (observer) { nativeObservers.add(observer); if (nativeStage) observer(nativeStage); }
    return nativeFlight.finally(() => { if (observer) nativeObservers.delete(observer); });
}
let reloadFlight: Promise<void> | undefined;
export function reloadNativeUpdate(): Promise<void> {
    return reloadFlight ??= Updates.reloadAsync().finally(() => { reloadFlight = undefined; });
}
