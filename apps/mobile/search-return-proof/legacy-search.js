// Original channels query and toolbar state, retained only for comparison.
import {useState} from 'react';
import {useTextDraft} from '../sources/buzz/use-text-draft';
export function useLegacyRoomSearch(workspaceId,identity){
 const [query,setQuery]=useTextDraft(`room-search:${workspaceId}`,'',identity);
 const [searchOpen,setSearchOpen]=useState(false);
 return {query,setQuery,searchOpen,setSearchOpen};
}
