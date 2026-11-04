import { ownerInputs, ownerInputShapes } from './generated-owner-input-shapes.js';
import { assertJsonBudget,jsonCodec } from '../wire-codec.js';
import {validateNeedsProjection} from './projection-codecs.js';
import {validateSavedWindow} from './saved-windows.js';
const codecs = Object.fromEntries(Object.entries(ownerInputs).map(([route, node]) =>
  [route, jsonCodec(ownerInputShapes, node, 64 * 1024)]));
/** This projection grants no authority; it validates the owner's closed inputs. */
export function validateOwnerInput(route: keyof typeof ownerInputs, input: unknown): void {
  if (!Object.hasOwn(codecs, route)) throw new Error('network codec: undeclared owner route');
  codecs[route]!.parse(input);
}
export function validateTrayProjection(value:unknown,workspace:string):boolean{
  try{
    assertJsonBudget(value,Infinity);
    const tray=value as {needs?:unknown;saved?:unknown;needsError?:unknown;savedError?:unknown};
    return !!tray&&typeof tray==='object'&&!Array.isArray(tray)&&Object.keys(tray).every(key=>key==='needs'||key==='saved')&&
      validateNeedsProjection(tray.needs)&&validateSavedWindow(tray.saved,workspace);
  }catch{return false;}
}
