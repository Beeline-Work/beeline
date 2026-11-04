import { assertJsonBudget } from '../wire-codec.js';
import {validateNeedsProjection} from './projection-codecs.js';
import {validateSavedWindow} from './saved-windows.js';
export function validateTrayProjection(value:unknown,workspace:string):boolean{
  try{
    assertJsonBudget(value,Infinity);
    const tray=value as {needs?:unknown;saved?:unknown;needsError?:unknown;savedError?:unknown};
    return !!tray&&typeof tray==='object'&&!Array.isArray(tray)&&Object.keys(tray).every(key=>key==='needs'||key==='saved')&&
      validateNeedsProjection(tray.needs)&&validateSavedWindow(tray.saved,workspace);
  }catch{return false;}
}
