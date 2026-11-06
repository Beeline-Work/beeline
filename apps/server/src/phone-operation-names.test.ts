import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PHONE_OPERATION_NAMES } from './phone-service.js';

/** Tests are excluded from server typecheck, so a hand-maintained `satisfies`
 * mirror can silently miss new client operations. Read the full client contract,
 * including imported route operations, at test runtime instead. */
function phoneOperationNames(): string[] {
  const path = fileURLToPath(new URL('../../../packages/api-contract/src/phone-operations.ts', import.meta.url));
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noLib: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  // Keep these source reads visible to the CI source-scanner test selector.
  host.readFile = file => {
    try { return readFileSync(file, 'utf8'); }
    catch { return undefined; }
  };
  const program = ts.createProgram([path], options, host);
  const source = program.getSourceFile(path)!;
  const declaration = source.statements.find(
    (node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === 'PhoneOperationMap',
  );
  if (!declaration) throw new Error('PhoneOperationMap was not found');
  return program.getTypeChecker().getTypeAtLocation(declaration).getProperties().map(symbol => symbol.name);
}

describe('PHONE_OPERATION_NAMES', () => {
  it('admits every operation the shared phone, web and desktop client contract can send', () => {
    const names = phoneOperationNames();
    expect(names).toContain('readRoom');
    expect(names).toContain('readMediaMetadata');
    const accepted: ReadonlySet<string> = PHONE_OPERATION_NAMES;
    expect(names.filter(name => !accepted.has(name))).toEqual([]);
  });
});
