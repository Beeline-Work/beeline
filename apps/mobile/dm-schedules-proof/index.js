import { registerRootComponent } from 'expo';
import React, { useState } from 'react';
import { View, Text } from 'react-native';
import { useFonts } from 'expo-font';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Menu from './menu';
import List from '../sources/app/(app)/beeline/settings/schedules';
import Subscription from '../sources/app/(app)/beeline/settings/subscription';
import { setNavigate } from './fixture';
function Proof() {
 const [page,setPage]=useState('menu');
 setNavigate(setPage);
 const [loaded]=useFonts({
 'SpaceGrotesk-Regular':require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
 'SpaceGrotesk-Medium':require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
 'SpaceGrotesk-SemiBold':require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
 'IBMPlexMono-Regular':require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
 });
 if(!loaded)return null;
 return <GestureHandlerRootView style={{flex:1}}><SafeAreaProvider>
 <View style={{flex:1,backgroundColor:'#14091A'}}>
 {page==='menu'? <><Text style={{color:'#f0f0f3',margin:40}}>DM visual fixture · Ruby</Text><Menu onOpen={()=>setPage('/beeline/settings/schedules')}/></>
 :page==='/beeline/settings/subscription'?<Subscription/>:<List/>}
 </View></SafeAreaProvider></GestureHandlerRootView>;
}
registerRootComponent(Proof);
