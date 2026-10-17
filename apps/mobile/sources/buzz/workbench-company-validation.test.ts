import { expect, it } from 'vitest';
import { companyWorkbench } from '@/test/company-workbench';
import { isWorkbenchCompanyIndex } from './workbench-company-validation';
it('accepts server presentation but rejects malformed persisted rows and targets', () => {
  const index = companyWorkbench().companies!; expect(isWorkbenchCompanyIndex(index)).toBe(true);
  expect(isWorkbenchCompanyIndex({ ...index, version: 2 })).toBe(false);
  expect(isWorkbenchCompanyIndex({ ...index, rows: [{ ...index.rows[0], items: null }] })).toBe(false);
  expect(isWorkbenchCompanyIndex({ ...index, rows: [{ ...index.rows[0], items: [{ ...index.rows[0]!.items[0], target: { kind: 'key' } }] }] })).toBe(false);
});
