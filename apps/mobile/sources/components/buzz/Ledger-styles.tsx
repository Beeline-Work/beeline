import { type TextStyle } from 'react-native';
import { styles } from './Ledger';


/**
 * The one provisional tone, shared by the two surfaces that must agree on it:
 * the live draft lane (`components/buzz/StreamingProse.tsx`) writes in it, and
 * the settle cross-fade below fades OUT of it. Read through a function so the
 * theme is resolved at render time, never snapshotted at import.
 */
export function provisionalProseStyle(): TextStyle {
  return styles.ledgerProvisional as TextStyle;
}


/** The settled agent-prose tone shared by final replies and durable narration. */
export function settledAgentProseStyle(): TextStyle {
  return styles.ledgerTextLuminous as TextStyle;
}
