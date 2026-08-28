import { tracking } from './tracking';

export { tracking } from './tracking';

type OtaEventProperties = {
    ota_version?: string;
    ota_runtime_version?: string;
};

export function trackOtaUpdateAvailable(properties?: OtaEventProperties): void {
    tracking?.capture('ota_update_available', {
        ota_version: properties?.ota_version ?? null,
        ota_runtime_version: properties?.ota_runtime_version ?? null,
    });
}

export function trackOtaUpdateApplied(properties?: OtaEventProperties): void {
    tracking?.capture('ota_update_applied', {
        ota_version: properties?.ota_version ?? null,
        ota_runtime_version: properties?.ota_runtime_version ?? null,
    });
}
