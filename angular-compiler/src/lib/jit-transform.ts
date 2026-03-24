import * as ts from 'typescript';

export interface JitTransformResult {
  code: string;
}

/**
 * JIT-only transform for Angular files.
 *
 * Unlike the full AOT compiler, this does NOT compile templates, emit
 * factory functions, or add any static metadata. It only:
 *
 * 1. Preserves all decorators intact for Angular's runtime JIT compiler.
 * 2. Strips TypeScript types (handled by the TS printer).
 *
 * Angular's JIT compiler reads @Component/@Directive/@Pipe/@Injectable
 * decorators at runtime and generates ɵcmp, ɵdir, ɵpipe, ɵprov, ɵfac,
 * and all signal metadata itself.
 */
export function jitTransform(sourceCode: string, fileName: string): JitTransformResult {
  const sourceFile = ts.createSourceFile(fileName, sourceCode, ts.ScriptTarget.Latest, true);
  const printer = ts.createPrinter({ removeComments: false });
  const code = printer.printFile(sourceFile);
  return { code };
}
