import React, { useEffect } from 'react';
import { ScrollView, TouchableOpacity, View, Text } from 'react-native';
import { router } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MonoMarkdown } from '@/components/buzz/MonoMarkdown';
import { getChangelogEntries, getLatestTitle, setLastViewedTitle } from '@/changelog';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { t } from '@/text';

export default function ChangelogScreen() {
    const insets = useSafeAreaInsets();
    const entries = getChangelogEntries();

    useEffect(() => {
        const latestTitle = getLatestTitle();
        if (latestTitle) {
            setLastViewedTitle(latestTitle);
        }
    }, []);

    if (entries.length === 0) {
        return (
            <View style={[styles.container, { paddingTop: insets.top }]}>
                <ChangelogHeader />
                <View style={styles.emptyState}>
                    <Text style={styles.emptyText}>
                        {t('changelog.noEntriesAvailable')}
                    </Text>
                </View>
            </View>
        );
    }

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <ChangelogHeader />
            <ScrollView
                style={styles.container}
                contentContainerStyle={[
                    styles.content,
                    {
                        paddingBottom: insets.bottom + 40,
                        maxWidth: layout.maxWidth,
                        alignSelf: 'center',
                        width: '100%'
                    }
                ]}
                showsVerticalScrollIndicator={false}
            >
                {entries.map((entry, index) => (
                    <View key={entry.title} style={styles.entryContainer}>
                        {index > 0 ? <View style={styles.entryDivider} /> : null}
                        <Text style={styles.titleText}>
                            {entry.title}
                        </Text>
                        {entry.summary ? (
                            <Text style={styles.summaryText}>
                                {entry.summary}
                            </Text>
                        ) : null}
                        {entry.markdown ? (
                            <MonoMarkdown markdown={entry.markdown} textStyle={styles.bodyText} />
                        ) : null}
                    </View>
                ))}
            </ScrollView>
        </View>
    );
}

function ChangelogHeader() {
    return (
        <View style={styles.header}>
            <TouchableOpacity
                accessibilityLabel={t('common.back')}
                accessibilityRole="button"
                onPress={() => router.back()}
                style={styles.back}
            >
                <Text style={styles.backText}>‹</Text>
            </TouchableOpacity>
            <View style={styles.headerCopy}>
                <Text style={styles.headerTitle}>{t('navigation.whatsNew')}</Text>
                <Text style={styles.headerMeta}>RELEASE LEDGER</Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.buzz.bgTerminal,
    },
    header: {
        minHeight: 64,
        paddingRight: 16,
        paddingVertical: 8,
        flexDirection: 'row',
        alignItems: 'center',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.buzz.border,
    },
    back: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    backText: {
        ...Typography.default(),
        fontFamily: theme.buzz.proseRegular,
        color: theme.buzz.chrome,
        fontSize: 28,
        lineHeight: 32,
    },
    headerCopy: { flex: 1, minWidth: 0 },
    headerTitle: {
        ...Typography.default('semiBold'),
        fontFamily: theme.buzz.proseSemibold,
        color: theme.buzz.textPrimary,
        fontSize: 17,
        lineHeight: 22,
    },
    headerMeta: {
        ...Typography.mono(),
        marginTop: 2,
        color: theme.buzz.ledgerGhost,
        fontSize: 9,
        lineHeight: 12,
        letterSpacing: 0.8,
    },
    content: {
        paddingHorizontal: 16,
        paddingTop: 16,
    },
    entryContainer: {
        marginBottom: 32,
    },
    entryDivider: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.buzz.borderQuiet,
        marginBottom: 32,
    },
    titleText: {
        ...Typography.default('semiBold'),
        fontFamily: theme.buzz.proseSemibold,
        fontSize: 20,
        lineHeight: 28,
        color: theme.buzz.textPrimary,
        marginBottom: 8,
    },
    summaryText: {
        ...Typography.default('regular'),
        fontFamily: theme.buzz.proseRegular,
        fontSize: 15,
        lineHeight: 22,
        color: theme.buzz.textSecondary,
        marginBottom: 16,
    },
    bodyText: {
        ...Typography.default(),
        fontFamily: theme.buzz.proseRegular,
        color: theme.buzz.ledgerBody,
        fontSize: 16,
        lineHeight: 25,
    },
    emptyState: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
    },
    emptyText: {
        ...Typography.default('regular'),
        fontFamily: theme.buzz.proseRegular,
        fontSize: 16,
        lineHeight: 24,
        color: theme.buzz.textSecondary,
        textAlign: 'center',
    }
}));
