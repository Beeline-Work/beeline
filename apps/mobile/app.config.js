const { execFileSync } = require('node:child_process');

const variant = process.env.APP_ENV || 'development';
// Buzzy fork of Happy (slopus/happy). Minimal rebrand — see README.md.
const name = {
    development: "Beeline (dev)",
    preview: "Beeline (preview)",
    production: "Beeline"
}[variant];
const bundleId = {
    development: "app.buzzy.mobile.dev",
    preview: "app.buzzy.mobile.preview",
    production: "app.buzzy.mobile"
}[variant];
// const stagingElevenLabsAgentId = 'agent_7801k2c0r5hjfraa1kdbytpvs6yt';
const productionElevenLabsAgentId = 'agent_6701k211syvvegba4kt7m68nxjmw';
const elevenLabsAgentId = {
    development: productionElevenLabsAgentId,
    preview: productionElevenLabsAgentId,
    production: productionElevenLabsAgentId,
}[variant];
const consoleLoggingDefault = {
    development: true,
    preview: true,
    production: false,
}[variant];
const buzzyRelayUrl = process.env.EXPO_PUBLIC_BUZZY_RELAY_URL || 'https://relay.buzzrouter.com';
const buzzyPushGatewayUrl = process.env.EXPO_PUBLIC_BUZZY_PUSH_GATEWAY_URL || 'https://push.buzzrouter.com';

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
        process.env.HAPPY_BUILD_COMMIT_SHA ||
        process.env.EAS_BUILD_GIT_COMMIT_HASH ||
        process.env.GITHUB_SHA ||
        git(['rev-parse', 'HEAD']);
    const commitTimestamp =
        process.env.HAPPY_BUILD_COMMIT_TIMESTAMP ||
        (commitSha
            ? git(['show', '-s', '--format=%cI', commitSha])
            : git(['show', '-s', '--format=%cI', 'HEAD']));

    return {
        commitSha,
        commitTimestamp,
    };
}

const buildMetadata = loadBuildMetadata();

export default {
    expo: {
        name,
        slug: "buzzy",
        version: "1.7.0",
        runtimeVersion: "21",
        orientation: "default",
        icon: "./sources/assets/images/icon.png",
        scheme: "buzzy",
        userInterfaceStyle: "automatic",
        ios: {
            supportsTablet: true,
            bundleIdentifier: bundleId,
            buildNumber: "1",
            ...(variant === 'production'
                ? { associatedDomains: ["applinks:relay.buzzrouter.com"] }
                : {}),
            config: {
                usesNonExemptEncryption: false
            },
            infoPlist: {
                NSMicrophoneUsageDescription: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations with AI.",
                NSLocalNetworkUsageDescription: "Allow $(PRODUCT_NAME) to find and connect to local devices on your network.",
                NSBonjourServices: ["_http._tcp", "_https._tcp"],
                // ATS:
                // - NSAllowsLocalNetworking: lets HTTP fetches reach LAN
                //   addresses (e.g. self-hosted server at 192.168.x.y) without
                //   forcing TLS. Production cloud server is HTTPS, so the
                //   default policy still applies there.
                // - In dev/preview only, allow arbitrary HTTP loads so a
                //   developer pointing the app at their machine doesn't have
                //   to ship a TLS cert just to test attachment uploads.
                NSAppTransportSecurity: variant === 'production'
                    ? { NSAllowsLocalNetworking: true }
                    : { NSAllowsLocalNetworking: true, NSAllowsArbitraryLoads: true }
            }
        },
        android: {
            versionCode: 22,
            adaptiveIcon: {
                foregroundImage: "./sources/assets/images/icon-adaptive.png",
                monochromeImage: "./sources/assets/images/icon-monochrome.png",
                backgroundColor: "#090909"
            },
            permissions: [
                "android.permission.RECORD_AUDIO",
                "android.permission.MODIFY_AUDIO_SETTINGS",
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
                            "host": "relay.buzzrouter.com",
                            "pathPrefix": "/join/"
                        },
                        {
                            "scheme": "https",
                            "host": "relay.buzzrouter.com",
                            "pathPrefix": "/auth/oidc/mobile-callback"
                        }
                    ],
                    "category": ["BROWSABLE", "DEFAULT"]
                },
                ...(variant === 'production' ? [
                {
                    "action": "VIEW",
                    "autoVerify": true,
                    "data": [
                        {
                            "scheme": "https",
                            "host": "app.happy.engineering",
                            "pathPrefix": "/"
                        }
                    ],
                    "category": ["BROWSABLE", "DEFAULT"]
                }
                ] : [])
            ]
        },
        web: {
            bundler: "metro",
            output: "single",
            favicon: "./sources/assets/images/favicon.png"
        },
        plugins: [
            require("./plugins/withEinkCompatibility.js"),
            [
                "expo-router",
                {
                    root: "./sources/app"
                }
            ],
            "expo-updates",
            "expo-asset",
            "expo-localization",
            "expo-mail-composer",
            [
                "expo-local-authentication",
                {
                    faceIDPermission: "Allow Beeline to verify it is you before showing your secret key."
                }
            ],
            "expo-secure-store",
            "expo-web-browser",
            "react-native-vision-camera",
            "@more-tech/react-native-libsodium",
            "react-native-audio-api",
            "@livekit/react-native-expo-plugin",
            "@config-plugins/react-native-webrtc",
            [
                "expo-audio",
                {
                    microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations."
                }
            ],
            [
                "expo-location",
                {
                    locationAlwaysAndWhenInUsePermission: "Allow $(PRODUCT_NAME) to improve AI quality by using your location.",
                    locationAlwaysPermission: "Allow $(PRODUCT_NAME) to improve AI quality by using your location.",
                    locationWhenInUsePermission: "Allow $(PRODUCT_NAME) to improve AI quality by using your location."
                }
            ],
            [
                "expo-calendar",
                {
                    "calendarPermission": "Allow $(PRODUCT_NAME) to access your calendar to improve AI quality."
                }
            ],
            [
                "expo-camera",
                {
                    cameraPermission: "Allow $(PRODUCT_NAME) to access your camera to scan QR codes and share photos with AI.",
                    microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone for voice conversations.",
                    recordAudioAndroid: true
                }
            ],
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
                        backgroundColor: "#090909",
                        dark: {
                            backgroundColor: "#090909",
                        }
                    },
                    android: {
                        image: "./sources/assets/images/splash-android-light.png",
                        backgroundColor: "#090909",
                        dark: {
                            image: "./sources/assets/images/splash-android-dark.png",
                            backgroundColor: "#090909",
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
                "expo-channel-name": "production"
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
                revenueCatAppleKey: process.env.EXPO_PUBLIC_REVENUE_CAT_APPLE,
                revenueCatGoogleKey: process.env.EXPO_PUBLIC_REVENUE_CAT_GOOGLE,
                revenueCatStripeKey: process.env.EXPO_PUBLIC_REVENUE_CAT_STRIPE,
                elevenLabsAgentId,
                consoleLoggingDefault,
                buildCommitSha: buildMetadata.commitSha,
                buildCommitTimestamp: buildMetadata.commitTimestamp,
                buzzyRelayUrl,
                buzzyPushGatewayUrl,
            }
        },
        owner: "lunchboxfortwo"
    }
};
