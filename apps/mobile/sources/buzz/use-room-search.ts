import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useEffect, useState } from 'react';
import { removeRoomSearchDrafts } from './room-search-drafts';

/** Returning from a Room starts a fresh search on the list. */
export function useRoomSearch(workspaceId: string | null, identity: string | null) {
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => { void removeRoomSearchDrafts(); }, []);
  useFocusEffect(useCallback(() => {
    setQuery('');
    setSearchOpen(false);
  }, [workspaceId, identity]));
  return { query, setQuery, searchOpen, setSearchOpen };
}
