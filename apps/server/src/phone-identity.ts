import type { RoomViewIdentity } from '@beeline/api-contract/phone';

export interface PhoneIdentityRow {
  id: string;
  kind: 'human' | 'agent';
  name: string;
  handle: string | null;
  avatar: string | null;
  face_id: string | null;
}

export function assetUrl(value: string, publicOrigin: string) {
  return value.startsWith('/') ? `${publicOrigin}${value}` : value;
}
export function phoneIdentity(row: PhoneIdentityRow, publicOrigin: string): RoomViewIdentity {
  return {
    pubkey: row.id,
    kind: row.kind,
    name: row.name,
    ...(row.handle ? { handle: row.handle } : {}),
    ...(row.avatar ? { avatar: assetUrl(row.avatar, publicOrigin) } : {}),
    ...(row.face_id ? { face: row.face_id } : {}),
  };
}
