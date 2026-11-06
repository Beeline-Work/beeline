import {expect,it,vi} from 'vitest';
import {postgresErrorContext,recordPostgresStatementError} from './postgres-error.js';
const captured=vi.hoisted(()=>vi.fn());
vi.mock('@sentry/node',()=>({captureException:captured}));
import {captureServerError} from './sentry.js';

it('Sentry retains PostgreSQL lock detail and a stable statement fingerprint without statement text or parameters',()=>{
  const error=Object.assign(new Error('deadlock detected'),{code:'40P01',detail:'Process 10 waits for ShareLock on transaction 20.'});
  recordPostgresStatementError(error,' SELECT id\n FROM memberships WHERE identity_id=$1 ');
  recordPostgresStatementError(error,'ROLLBACK');
  const equivalent=Object.assign(new Error('lock timeout'),{code:'55P03'});
  recordPostgresStatementError(equivalent,'SELECT id FROM memberships WHERE identity_id=$1');
  captureServerError(error);
  const context=postgresErrorContext(error)!;
  expect(context).toEqual({code:'40P01',detail:error.detail,statement_fingerprint:expect.stringMatching(/^[a-f0-9]{16}$/)});
  expect(context.statement_fingerprint).toBe(postgresErrorContext(equivalent)!.statement_fingerprint);
  expect(captured).toHaveBeenCalledWith(error,{tags:{surface:'server'},contexts:{postgresql:context}});
  expect(JSON.stringify(context)).not.toContain('SELECT');
  expect(postgresErrorContext(new Error('ordinary failure'))).toBeUndefined();
});
