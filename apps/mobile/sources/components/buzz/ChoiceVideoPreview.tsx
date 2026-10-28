import React from 'react';
import { Image, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { monolithSession } from '@/auth/monolith-session';

export function ChoiceVideoPreview({ frameUrl, title, description, visibility }: { frameUrl: string; title: string; description: string; visibility: string }) {
  const [authorization, setAuthorization] = React.useState<string>();
  const [ready, setReady] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    setFailed(false);
    setReady(false);
    void monolithSession.authorization().then(token => { if (live) setAuthorization(`Bearer ${token}`); }).catch(() => undefined).finally(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, [frameUrl]);
  return <View>
    {!ready ? <View style={styles.frame} /> : failed ? <Text style={styles.description}>Frame unavailable</Text> : <Image
      source={{ uri: frameUrl, ...(authorization ? { headers: { Authorization: authorization } } : {}) }}
      accessibilityLabel={`Frame from ${title}`} resizeMode="contain" style={styles.frame} onError={() => setFailed(true)} />}
    <Text style={styles.description}>Visibility: {visibility}</Text>
    {description ? <Text style={styles.description}>{description}</Text> : null}
  </View>;
}

const styles = StyleSheet.create(theme => ({
  frame: { width: '100%', aspectRatio: 16 / 9 },
  description: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
}));
