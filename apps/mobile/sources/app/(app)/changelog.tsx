import React, { useEffect } from 'react';
import { ScrollView, View, Text } from 'react-native';
import { router } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MonoMarkdown } from '@/components/buzz/MonoMarkdown';
import { getChangelogEntries, getLatestTitle, setLastViewedTitle } from '@/changelog';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { useLayoutClass } from '@/utils/responsive';
import { PageHeader } from '@/components/buzz/PageHeader';

export default function ChangelogScreen() {
    const insets = useSafeAreaInsets();
    const isCompact = useLayoutClass() === 'compact';
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
                        maxWidth: isCompact ? '100%' : layout.maxWidth,
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
        <PageHeader
            backAccessibilityLabel={t('common.back')}
            meta="RELEASE LEDGER"
            onBack={() => router.back()}
            prominent
            title={t('navigation.whatsNew')}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.buzz.bgTerminal,
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
        ...theme.buzz.type.bodyStrong,
        color: theme.buzz.textPrimary,
        marginBottom: 8,
    },
    summaryText: {
        ...theme.buzz.type.meta,
        color: theme.buzz.textSecondary,
        marginBottom: 16,
    },
    bodyText: {
        ...theme.buzz.type.body,
        color: theme.buzz.ledgerBody,
    },
    emptyState: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
    },
    emptyText: {
        ...theme.buzz.type.body,
        color: theme.buzz.textSecondary,
        textAlign: 'center',
    }
}));
