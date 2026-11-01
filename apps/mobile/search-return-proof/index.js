import React from 'react';
import {registerRootComponent} from 'expo';
import {View,Text} from 'react-native';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {useFonts} from 'expo-font';
import {RoomListToolbar} from '../sources/components/buzz/RoomListToolbar';
import {MessageSearchResults} from '../sources/components/buzz/MessageSearchResults';
import {useMessageSearch} from '../sources/buzz/use-message-search';
import {useRoomSearch} from '../sources/buzz/use-room-search';
import {useLegacyRoomSearch} from './legacy-search';
import {baseline} from './search-mode';
const useSearch=baseline?useLegacyRoomSearch:useRoomSearch;
const Stack=createNativeStackNavigator();
const result={messageId:'fixture-message',roomId:'engineering',roomName:'Engineering',authorName:'Alex',createdAt:Date.now()/1000,snippet:[{text:'release checklist',match:true}]};
const read=async()=>({results:[result]});
function List({navigation}) {
 const {query,setQuery,searchOpen,setSearchOpen}=useSearch('workspace','viewer');
 const search=useMessageSearch(read,'workspace',query);
 return <View style={{flex:1,backgroundColor:'#F3EEE4'}}>
 <RoomListToolbar filter="all" onFilter={()=>{}} query={query} onQuery={setQuery} searchOpen={searchOpen} onSearchOpenChange={setSearchOpen}/>
 {!query && <View><Text style={{padding:16,fontSize:20}}>Engineering</Text><Text style={{padding:16,fontSize:20}}>Design notes</Text></View>}
 <MessageSearchResults search={search} now={Date.now()} onOpen={()=>navigation.navigate('Result')}/>
 </View>;
}
function Result(){return <View style={{flex:1,backgroundColor:'#F3EEE4',padding:24}}><Text style={{fontSize:20}}>Alex: release checklist</Text><Text>Press Android Back to return to Rooms.</Text></View>}
function App(){const [loaded]=useFonts({'SpaceGrotesk-Regular':require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),'SpaceGrotesk-Medium':require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),'SpaceGrotesk-SemiBold':require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf')});if(!loaded)return null;return <NavigationContainer><Stack.Navigator><Stack.Screen name="Rooms" component={List}/><Stack.Screen name="Result" component={Result}/></Stack.Navigator></NavigationContainer>}
registerRootComponent(App);
