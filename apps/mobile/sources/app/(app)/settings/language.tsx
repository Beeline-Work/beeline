import React from 'react';
import { Text, View } from 'react-native';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  t,
  getLanguageNativeName,
  SUPPORTED_LANGUAGES,
  SUPPORTED_LANGUAGE_CODES,
  type SupportedLanguage,
} from '@/text';
import { useUpdates } from '@/hooks/useUpdates';
import * as Localization from 'expo-localization';
import { HullDialog } from '@/components/buzz/HullDialog';

type LanguageOption = 'auto' | SupportedLanguage;

interface LanguageItem {
  key: LanguageOption;
  title: string;
  subtitle?: string;
}

export default function LanguageSettingsScreen() {
  const { theme } = useUnistyles();
  const [preferredLanguage, setPreferredLanguage] = useSettingMutable('preferredLanguage');
  const { reloadApp } = useUpdates();
  const [pendingLanguage, setPendingLanguage] = React.useState<LanguageOption | null>(null);

  // Get device locale for automatic detection
  const deviceLocale = Localization.getLocales()?.[0]?.languageTag ?? 'en-US';
  const deviceLanguage = deviceLocale.split('-')[0].toLowerCase();
  const detectedLanguageName =
    deviceLanguage in SUPPORTED_LANGUAGES
      ? getLanguageNativeName(deviceLanguage as keyof typeof SUPPORTED_LANGUAGES)
      : getLanguageNativeName('en');

  // Current selection
  const currentSelection: LanguageOption =
    preferredLanguage === null
      ? 'auto'
      : SUPPORTED_LANGUAGE_CODES.includes(preferredLanguage as SupportedLanguage)
        ? (preferredLanguage as SupportedLanguage)
        : 'auto';

  // Language options - dynamically generated from supported languages
  const languageOptions: LanguageItem[] = [
    {
      key: 'auto',
      title: t('settingsLanguage.automatic'),
      subtitle: `${t('settingsLanguage.automaticSubtitle')} (${detectedLanguageName})`,
    },
    ...SUPPORTED_LANGUAGE_CODES.map((code) => ({
      key: code,
      title: getLanguageNativeName(code),
    })),
  ];

  const handleLanguageChange = (newLanguage: LanguageOption) => {
    if (newLanguage === currentSelection) {
      return; // No change
    }
    setPendingLanguage(newLanguage);
  };

  const confirmLanguageChange = () => {
    if (pendingLanguage === null) {
      return;
    }

    const newPreference = pendingLanguage === 'auto' ? null : pendingLanguage;
    setPendingLanguage(null);
    setPreferredLanguage(newPreference);

    // Small delay to ensure setting is saved before the restart.
    setTimeout(() => {
      reloadApp();
    }, 100);
  };

  return (
    <View style={styles.screen}>
      <ItemList style={{ paddingTop: 0 }}>
        <ItemGroup
          title={t('settingsLanguage.currentLanguage')}
          footer={t('settingsLanguage.description')}
        >
          {languageOptions.map((option) => (
            <Item
              key={option.key}
              title={option.title}
              subtitle={option.subtitle}
              rightElement={
                currentSelection === option.key ? (
                  <Text
                    style={{
                      color: theme.buzz.accent,
                      fontFamily: theme.buzz.monoSemibold,
                      fontSize: 17,
                    }}
                  >
                    ✓
                  </Text>
                ) : null
              }
              onPress={() => handleLanguageChange(option.key)}
              showChevron={false}
            />
          ))}
        </ItemGroup>
      </ItemList>

      <HullDialog
        actions={[
          {
            label: t('common.cancel'),
            onPress: () => setPendingLanguage(null),
            variant: 'quiet',
          },
          {
            label: t('common.ok'),
            onPress: confirmLanguageChange,
            variant: 'primary',
          },
        ]}
        body={t('settingsLanguage.needsRestartMessage')}
        dismissOnBackdrop={false}
        onRequestClose={() => setPendingLanguage(null)}
        testID="language-restart-confirmation"
        title={t('settingsLanguage.needsRestart')}
        visible={pendingLanguage !== null}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.buzz.bgTerminal,
  },
}));
