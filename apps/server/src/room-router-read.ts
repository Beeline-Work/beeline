import { taggedIdentityIdsSql } from './message-mentions.js';
export function roomMessageTagsSql(alias: string): string {
  return `CASE WHEN strpos(${alias}.text,'@')=0 THEN '{}'::text[] ELSE ${taggedIdentityIdsSql(alias)} END`;
}
