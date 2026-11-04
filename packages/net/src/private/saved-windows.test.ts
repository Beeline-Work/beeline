import { describe,expect,it } from 'vitest';
import type { SavedRow,SavedRowPayload,SavedWindow } from '@beeline/api-contract/router-protocol';
import { replaceSavedWindowRows,validateSavedWindow } from './saved-windows.js';
const workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222';
const row=(n:number,us='10413792000123456'):{-readonly[K in keyof SavedRow]:SavedRow[K]}=>({bookmarkId:`33333333-3333-4333-8333-${String(n).padStart(12,'0')}`,
  order:`${us},m${String(n).padStart(3,'0')}`,before:`saved1.anchor${n}`,value:{messageId:`m${String(n).padStart(3,'0')}`,
    workspaceId:workspace,roomId:room,roomName:'Synthetic',roomKind:'room',messageCreatedAt:1,bookmarkedAt:2,available:true,text:`row${n}`}});
const window=(rows=[row(1),row(2)]):SavedWindow=>({windowId:`saved1:${'a'.repeat(64)}`,before:'saved1.start',rows,next:'saved1.end'});
const replace=(value:SavedRow):SavedRowPayload=>({kind:'saved-row-replace',scope:workspace,row:value});
const remove=(value:SavedRow):SavedRowPayload=>({kind:'saved-row-remove',scope:workspace,bookmarkId:value.bookmarkId,messageId:value.value.messageId});

describe('mechanical sealed Saved windows',()=>{
  it('validates exact bigint ordering, bounds, duplicates and unavailable-pointer privacy',()=>{
    expect(validateSavedWindow(window(),workspace)).toBe(true);
    expect(validateSavedWindow(window([row(1,'10413792000123457'),row(2)]),workspace)).toBe(true);
    expect(validateSavedWindow(window([row(1),row(2,'10413792000123457')]),workspace)).toBe(false);
    expect(validateSavedWindow(window([row(2),row(1)]),workspace)).toBe(false);
    expect(validateSavedWindow(window([row(1),row(1)]),workspace)).toBe(false);
    expect(validateSavedWindow(window(Array.from({length:31},(_,n)=>row(n))),workspace)).toBe(false);
    const hidden=row(1);hidden.value={...hidden.value,available:false};
    expect(validateSavedWindow(window([hidden]),workspace)).toBe(false);
    const {text:_text,...pointer}=hidden.value;hidden.value=pointer;
    expect(validateSavedWindow(window([hidden]),workspace)).toBe(true);
  });
  it('accepts explicit source excerpts, replaces their marker with the complete row and rejects private preview residue',()=>{
    const excerpt=row(1);excerpt.value={...excerpt.value,text:'Preview…',textTruncated:true};
    expect(validateSavedWindow(window([excerpt]),workspace)).toBe(true);
    const result=replaceSavedWindowRows(window([excerpt]),workspace,[replace(row(1))]);
    expect(result.rows[0]!.value).not.toHaveProperty('textTruncated');
    const {text:_text,...withoutText}=excerpt.value;excerpt.value={...withoutText,available:false};
    expect(validateSavedWindow(window([excerpt]),workspace)).toBe(false);
  });
  it('replaces only complete held rows without changing membership, order, boundaries or the original window',()=>{
    const held=window(),updated=row(2);updated.value={...updated.value,text:'new',roomName:'Renamed'};
    const result=replaceSavedWindowRows(held,workspace,[replace(updated),replace(row(3))]);
    expect(result).toEqual({...held,rows:[row(1),updated]});
    expect(held.rows[1]!.value.text).toBe('row2');
    updated.value={...updated.value,text:'mutated caller'};
    expect(result.rows[1]!.value.text).toBe('new');
  });
  it('never refills a removed last/all row and preserves the exact continuation after emptying',()=>{
    const held=window();
    const result=replaceSavedWindowRows(held,workspace,[remove(row(1)),remove(row(2)),replace(row(3))]);
    expect(result).toEqual({...held,rows:[]});
    expect(validateSavedWindow(result,workspace)).toBe(true);
    expect(replaceSavedWindowRows(result,workspace,[replace(row(1))])).toBe(result);
  });
  it('does not resurrect a removed incarnation when delete/re-add or reordered late replacement arrives',()=>{
    const original=row(1),readded={...row(9),value:{...row(1).value},order:row(1).order};
    const result=replaceSavedWindowRows(window([original]),workspace,[remove(original),replace(readded),replace(original)]);
    expect(result.rows).toEqual([]);
    expect(replaceSavedWindowRows(window([readded]),workspace,[remove(original)]).rows).toEqual([readded]);
  });
  it.each(['order','before','message','room'] as const)('rejects immutable %s changes within a held incarnation atomically',field=>{
    const held=window(),changed=row(2);
    const bad=field==='order'?{...changed,order:`1,${changed.value.messageId}`}:
      field==='before'?{...changed,before:'saved1.changed'}:
      field==='message'?{...changed,order:'1,other',value:{...changed.value,messageId:'other'}}:
      {...changed,value:{...changed.value,roomId:'44444444-4444-4444-8444-444444444444'}};
    expect(()=>replaceSavedWindowRows(held,workspace,[remove(row(1)),replace(bad)])).toThrow('Saved incarnation changed');
    expect(held.rows).toEqual([row(1),row(2)]);
  });
  it('rejects cross-scope facts and a removal with mismatching immutable message identity',()=>{
    expect(()=>replaceSavedWindowRows(window(),workspace,[{...remove(row(1)),scope:room}])).toThrow('Invalid Saved scope');
    expect(()=>replaceSavedWindowRows(window(),workspace,[{kind:'saved-row-remove',scope:workspace,bookmarkId:row(1).bookmarkId,messageId:'other'}])).toThrow('Saved incarnation changed');
  });
  it('rejects accessors before reading them and enforces logical and per-window byte bounds',()=>{
    let calls=0;const malicious={...row(1),get before(){calls++;return 'saved1.x';}};
    expect(validateSavedWindow(window([malicious]),workspace)).toBe(false);expect(calls).toBe(0);
    const oversized=row(1);oversized.value={...oversized.value,text:'x'.repeat(65536)};
    expect(()=>replaceSavedWindowRows(window(),workspace,[replace(oversized)])).toThrow();
    expect(()=>replaceSavedWindowRows(window(),workspace,Array.from({length:257},()=>remove(row(1))))).toThrow('Invalid Saved window');
  });
});
