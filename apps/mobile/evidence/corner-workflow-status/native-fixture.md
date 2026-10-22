# Native fixture source

Temporary verification source; never included in the production app entry.

## entry.tsx

```tsx
import React from 'react';
import { registerRootComponent } from 'expo';
import { View, Text, Pressable } from 'react-native';
import { useFonts } from 'expo-font';
import { StyleSheet, UnistylesRuntime } from 'react-native-unistyles';
import { obsidianTheme, boneTheme } from '../sources/theme';
import { CornerObjectiveLine } from '../sources/components/buzz/CornerObjectiveLine';
import { useRoomWorkflowRun } from '../sources/buzz/use-room-workflow-run';
StyleSheet.configure({themes:{obsidian:obsidianTheme,bone:boneTheme},settings:{initialTheme:'obsidian'}});
function Proof(){
 const [theme,setTheme]=React.useState('obsidian');
 const run=useRoomWorkflowRun('proof-corner');
 const [loaded]=useFonts({'SpaceGrotesk-Regular':require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),'SpaceGrotesk-Medium':require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf')});
 if(!loaded)return null;
 return <View style={{flex:1,paddingTop:64,backgroundColor:theme==='obsidian'?'#14091A':'#F3EEE4'}}>
 <Text style={{color:theme==='obsidian'?'#f0f0f3':'#171310',fontFamily:'SpaceGrotesk-Medium',fontSize:22,padding:16}}>Quiet workflow status</Text>
 <CornerObjectiveLine objective="Keep workflow status quiet when the connection hiccups" workflow={run.workflow} onOpenBrief={()=>{}} onOpenWorkflow={()=>{}}/>
 <Pressable accessibilityLabel="Switch theme" onPress={()=>{const next=theme==='obsidian'?'bone':'obsidian';UnistylesRuntime.setTheme(next);setTheme(next);}}><Text style={{padding:16,color:'#b08a4a'}}>Switch theme</Text></Pressable>
 </View>;
}
registerRootComponent(Proof);

```

## operation.ts

```tsx
export const monolithPhoneOperation=async()=>{throw new Error('forced workflow fetch failure');};
```

## live.ts

```tsx
export const sharedLiveConnection=()=>({register:async()=>()=>{}});
```

## workbench.ts

```tsx
export const getWorkbenchSource=()=>undefined;
```

## corners.ts

```tsx
export const subscribeRoomCornerFacts=()=>()=>{};
```

## router.ts

```tsx
import React from 'react';export const useFocusEffect=(effect:any)=>React.useEffect(effect,[effect]);
```
