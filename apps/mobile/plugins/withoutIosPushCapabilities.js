const {
    withEntitlementsPlist,
    withInfoPlist,
} = require('@expo/config-plugins');

/**
 * Keep expo-notifications' Android setup while iOS push is not implemented.
 * Associated Domains are managed independently for universal invite links.
 */
const withoutIosPushCapabilities = (config) => {
    config = withEntitlementsPlist(config, (entitlementsConfig) => {
        delete entitlementsConfig.modResults['aps-environment'];
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
