const { execFileSync } = require('node:child_process');
const { version: releaseVersion } = require('./package.json');

const name = "Beeline";
const bundleId = "app.usebeeline.mobile";
const scheme = "beeline";
const updatesChannel = process.env.EXPO_UPDATES_CHANNEL || "production";
const consoleLoggingDefault = process.env.NODE_ENV !== 'production';
const buzzyRelayUrl = process.env.EXPO_PUBLIC_BUZZY_RELAY_URL || 'https://usebeeline.app';
const buzzyPushGatewayUrl = process.env.EXPO_PUBLIC_BUZZY_PUSH_GATEWAY_URL || 'https://usebeeline.app/push';

function git(args) {
    try {
        return execFileSync('git', args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || undefined;
    } catch {
        return undefined;
    }
}

function loadBuildMetadata() {
    const commitSha =
        process.env.EAS_BUILD_GIT_COMMIT_HASH ||
        process.env.GITHUB_SHA ||
        git(['rev-parse', 'HEAD']);
    const commitTimestamp =
        commitSha
            ? git(['show', '-s', '--format=%cI', commitSha])
            : git(['show', '-s', '--format=%cI', 'HEAD']);

    return {
        commitSha,
        commitTimestamp,
    };
}

const buildMetadata = loadBuildMetadata();

export default {
    expo: {
        name,
        // The EAS project slug is operational metadata; native identity is
        // fixed independently by the bundleId and scheme constants above.
        slug: "buzzy",
        // Android versionName and iOS CFBundleShortVersionString both derive
        // from this package's release version. `version:check` rejects a tag
        // that does not match it before a release build starts.
        version: releaseVersion,
        runtimeVersion: "21",
        orientation: "default",
        icon: "./sources/assets/images/icon.png",
        scheme,
        userInterfaceStyle: "automatic",
        ios: {
            icon: "./sources/assets/images/icon-ios.png",
            supportsTablet: true,
            bundleIdentifier: bundleId,
            buildNumber: "1",
            associatedDomains: ["applinks:usebeeline.app", "applinks:relay.buzzrouter.com"],
            config: {
                usesNonExemptEncryption: false
            },
            infoPlist: {
                NSLocalNetworkUsageDescription: "Allow $(PRODUCT_NAME) to find and connect to local devices on your network.",
                NSBonjourServices: ["_http._tcp", "_https._tcp"],
                // ATS:
                // - NSAllowsLocalNetworking: lets HTTP fetches reach LAN
                //   addresses (e.g. self-hosted server at 192.168.x.y) without
                //   forcing TLS. Production cloud server is HTTPS, so the
                //   default policy still applies there.
                // - In local development only, allow arbitrary HTTP loads so a
                //   developer pointing the app at their machine doesn't have
                //   to ship a TLS cert just to test attachment uploads.
                NSAppTransportSecurity: process.env.NODE_ENV === 'production'
                    ? { NSAllowsLocalNetworking: true }
                    : { NSAllowsLocalNetworking: true, NSAllowsArbitraryLoads: true }
            }
        },
        android: {
            versionCode: 27,
            adaptiveIcon: {
                foregroundImage: "./sources/assets/images/icon-adaptive.png",
                // Owner-final treatment: brass loop on a flat aubergine field. Keep the
                // fallback in sync if a toolchain drops the generated background image.
                backgroundImage: "./sources/assets/images/icon-adaptive-background.png",
                backgroundColor: "#14091A"
            },
            permissions: [
                "android.permission.ACCESS_NETWORK_STATE",
                "android.permission.POST_NOTIFICATIONS",
            ],
            blockedPermissions: [
                "android.permission.ACTIVITY_RECOGNITION",
                // Not using external storage/media access for now — blocks Google Play photo/video permission declaration
                "android.permission.READ_EXTERNAL_STORAGE",
                "android.permission.WRITE_EXTERNAL_STORAGE",
                "android.permission.READ_MEDIA_IMAGES",
                "android.permission.READ_MEDIA_VIDEO",
            ],
            package: bundleId,
            googleServicesFile: "./google-services.json",
            intentFilters: [
                {
                    "action": "VIEW",
                    "autoVerify": true,
                    "data": [
                        {
                            "scheme": "https",
                            "host": "usebeeline.app",
                            "pathPrefix": "/join/"
                        },
                        {
                            "scheme": "https",
                            "host": "usebeeline.app",
                            "pathPrefix": "/auth/github/mobile-callback"
                        },
                        {
                            "scheme": "https",
                            "host": "relay.buzzrouter.com",
                            "pathPrefix": "/join/"
                        },
                        {
                            "scheme": "https",
                            "host": "relay.buzzrouter.com",
                            "pathPrefix": "/auth/github/mobile-callback"
                        },
                    ],
                    "category": ["BROWSABLE", "DEFAULT"]
                }
            ]
        },
        web: {
            bundler: "metro",
            output: "single",
            favicon: "./sources/assets/images/favicon.png"
        },
        plugins: [
            require("./plugins/withEinkCompatibility.js"),
            require("./plugins/withAndroidBuildTooling.js"),
            [
                "expo-router",
                {
                    root: "./sources/app"
                }
            ],
            "expo-updates",
            "expo-asset",
            "expo-localization",
            [
                "expo-local-authentication",
                {
                    faceIDPermission: "Allow Beeline to verify it is you before showing your secret key."
                }
            ],
            "expo-secure-store",
            "expo-web-browser",
            require("./plugins/withoutIosPushCapabilities.js"),
            [
                "expo-notifications",
                {
                    "enableBackgroundRemoteNotifications": true,
                    "icon": "./sources/assets/images/icon-notification.png"
                }
            ],
            [
                'expo-splash-screen',
                {
                    ios: {
                        backgroundColor: "#14091A",
                        dark: {
                            backgroundColor: "#14091A",
                        }
                    },
                    android: {
                        image: "./sources/assets/images/splash-android-light.png",
                        imageWidth: 150,
                        resizeMode: "contain",
                        backgroundColor: "#14091A",
                        dark: {
                            image: "./sources/assets/images/splash-android-dark.png",
                            backgroundColor: "#14091A",
                        }
                    }
                }
            ]
        ],
        experiments: {
            typedRoutes: true
        },
        updates: {
            url: "https://u.expo.dev/58f1e94e-5ce5-475e-9dde-3eaa9e36699c",
            requestHeaders: {
                "expo-channel-name": updatesChannel
            }
        },
        extra: {
            router: {
                root: "./sources/app"
            },
            eas: {
                projectId: "58f1e94e-5ce5-475e-9dde-3eaa9e36699c"
            },
            app: {
                postHogKey: process.env.EXPO_PUBLIC_POSTHOG_API_KEY,
                consoleLoggingDefault,
                buildCommitSha: buildMetadata.commitSha,
                buildCommitTimestamp: buildMetadata.commitTimestamp,
                releaseVersion: process.env.EXPO_PUBLIC_BEELINE_RELEASE_VERSION,
                releaseSha: process.env.EXPO_PUBLIC_BEELINE_RELEASE_SHA || buildMetadata.commitSha,
                buzzyRelayUrl,
                buzzyPushGatewayUrl,
            }
        },
        owner: "lunchboxfortwo"
    }
};
