# LiveKit's JNI bridge and shaded WebRTC callbacks are called from native code.
# These mirror the dependencies' consumer rules; do not keep all dependencies.
-keep class com.livekit.** { *; }
-keep class livekit.org.webrtc.** { *; }
-keep class org.jni_zero.** { *; }
# The bundled WebRTC AAR relocates JNI Zero along with org.webrtc.
# Its native JNI_OnLoad looks up JniInit by this fully qualified name.
-keep class livekit.org.jni_zero.** { *; }

# Local Expo modules are discovered by the generated module registry.
-keep class app.usebeeline.crashtrace.** { *; }
-keep class app.usebeeline.googlepicker.** { *; }
-keep class app.usebeeline.launchappearance.** { *; }
-keep class app.usebeeline.modalnavigationbar.** { *; }
-keep class app.usebeeline.voicebackgroundaudio.** { *; }

# Expo and React Native contribute their own consumer rules for reflection.
# Backport the narrow rule from expo/expo#51206: the installed Expo version
# fails record argument conversion when R8 renames this reflection annotation.
-keep @interface expo.modules.kotlin.records.Field { *; }
# TaskManager loads this class by its manifest metadata value.
-keep class expo.modules.adapters.react.apploader.RNHeadlessAppLoader { *; }
# TaskManager constructs registered consumers through reflection.
-keep class * implements expo.modules.interfaces.taskManager.TaskConsumerInterface { <init>(...); }
# Install-referrer consumers invoke the builder and response methods by name.
-keep class com.android.installreferrer.api.** { *; }
# Sentry is excluded from native autolinking; PostHog is JavaScript-only.
# Neither currently contributes JVM classes requiring application keep rules.
-keepattributes SourceFile,LineNumberTable

# AndroidServer uses plain HTTP. Netty probes optional desktop TLS and logging
# providers; absent providers fall back to JDK logging/SSL. Its self-signed
# certificate generator is unused. Keep this list exact so new gaps still fail.
-dontwarn io.netty.internal.tcnative.Buffer
-dontwarn io.netty.internal.tcnative.CertificateCallback
-dontwarn io.netty.internal.tcnative.CertificateVerifier
-dontwarn io.netty.internal.tcnative.Library
-dontwarn io.netty.internal.tcnative.SSL
-dontwarn io.netty.internal.tcnative.SSLContext
-dontwarn io.netty.internal.tcnative.SniHostNameMatcher
-dontwarn org.apache.log4j.Level
-dontwarn org.apache.log4j.Logger
-dontwarn org.apache.log4j.Priority
-dontwarn org.apache.logging.log4j.LogManager
-dontwarn org.apache.logging.log4j.Logger
-dontwarn org.apache.logging.log4j.message.MessageFactory
-dontwarn org.apache.logging.log4j.spi.ExtendedLogger
-dontwarn org.apache.logging.log4j.spi.ExtendedLoggerWrapper
-dontwarn org.bouncycastle.cert.X509CertificateHolder
-dontwarn org.bouncycastle.cert.X509v3CertificateBuilder
-dontwarn org.bouncycastle.cert.jcajce.JcaX509CertificateConverter
-dontwarn org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder
-dontwarn org.bouncycastle.operator.ContentSigner
-dontwarn org.bouncycastle.operator.jcajce.JcaContentSignerBuilder
-dontwarn org.slf4j.ILoggerFactory
-dontwarn org.slf4j.Logger
-dontwarn org.slf4j.LoggerFactory
-dontwarn org.slf4j.Marker
-dontwarn org.slf4j.helpers.FormattingTuple
-dontwarn org.slf4j.helpers.MessageFormatter
-dontwarn org.slf4j.helpers.NOPLoggerFactory
-dontwarn org.slf4j.spi.LocationAwareLogger
-dontwarn sun.security.util.ObjectIdentifier
-dontwarn sun.security.x509.AlgorithmId
-dontwarn sun.security.x509.CertificateAlgorithmId
-dontwarn sun.security.x509.CertificateIssuerName
-dontwarn sun.security.x509.CertificateSerialNumber
-dontwarn sun.security.x509.CertificateSubjectName
-dontwarn sun.security.x509.CertificateValidity
-dontwarn sun.security.x509.CertificateVersion
-dontwarn sun.security.x509.CertificateX509Key
-dontwarn sun.security.x509.X500Name
-dontwarn sun.security.x509.X509CertImpl
-dontwarn sun.security.x509.X509CertInfo
