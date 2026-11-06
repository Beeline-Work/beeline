import {queryFingerprint} from './query-profile.js';

const statements=new WeakMap<object,string>();

/** Keep the original pg error and stack; record a fingerprint, never parameters. */
export function recordPostgresStatementError(error:unknown,sql:string):void {
  if(typeof error==='object' && error!==null && !statements.has(error))
    statements.set(error,queryFingerprint(sql));
}

export function postgresErrorContext(error:unknown):Record<string,string>|undefined {
  if(typeof error!=='object' || error===null) return;
  const {code,detail}=error as {code?:unknown;detail?:unknown};
  if(typeof code!=='string' || !/^[0-9A-Z]{5}$/.test(code)) return;
  const fingerprint=statements.get(error);
  return {code,...(typeof detail==='string'?{detail}:{}),
    ...(fingerprint?{statement_fingerprint:fingerprint}:{})};
}
