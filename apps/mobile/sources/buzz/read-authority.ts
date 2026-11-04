// Only server-read-owner holds this capability. Consumers receive observations,
// never a transport/cache-writing handle.
declare const readAuthority: unique symbol;
export type ReadAuthority = { readonly [readAuthority]: true };
export type OwnedSurfaceRead =
  'readChats' | 'countNeedsYou' | 'readNeedsYou' | 'readTray' | 'listMessageBookmarks';
