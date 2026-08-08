const {
    withEntitlementsPlist,
    withInfoPlist,
} = require('@expo/config-plugins');

/**
 * Keep expo-notifications' Android setup while iOS push is not implemented.
 * Re-add these capabilities when the iOS client gains push or universal links.
 */
const withoutIosPushCapabilities = (config) => {
    config = withEntitlementsPlist(config, (entitlementsConfig) => {
        delete entitlementsConfig.modResults['aps-environment'];
        delete entitlementsConfig.modResults['com.apple.developer.associated-domains'];
        return entitlementsConfig;
    });

    return withInfoPlist(config, (infoPlistConfig) => {
        const backgroundModes = infoPlistConfig.modResults.UIBackgroundModes;
        if (Array.isArray(backgroundModes)) {
            infoPlistConfig.modResults.UIBackgroundModes = backgroundModes.filter(
                (mode) => mode !== 'remote-notification',
            );
        }
        return infoPlistConfig;
    });
};

module.exports = withoutIosPushCapabilities;
