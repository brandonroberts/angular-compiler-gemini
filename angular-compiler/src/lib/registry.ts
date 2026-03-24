import * as ts from 'typescript';

export interface RegistryEntry {
  /** CSS selector for components/directives, pipe name for pipes, class name for NgModules */
  selector: string;
  /** What kind of Angular declaration this is */
  kind: 'component' | 'directive' | 'pipe' | 'ngmodule';
  /** The pipe name (only for pipes) */
  pipeName?: string;
  /** Exported class names (only for NgModules) */
  exports?: string[];
  /** The source file this declaration was found in */
  fileName: string;
  /** The class name */
  className: string;
}

/** Maps class name → registry entry */
export type ComponentRegistry = Map<string, RegistryEntry>;

/**
 * Lightweight scan of a TypeScript file to extract Angular decorator metadata
 * without performing full compilation. Used by the global analysis plugin
 * to build the registry before single-file compilation.
 */
export function scanFile(code: string, fileName: string): RegistryEntry[] {
  const entries: RegistryEntry[] = [];

  if (!/@(Component|Directive|Pipe|NgModule)/.test(code)) {
    return entries;
  }

  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);

  for (const stmt of sourceFile.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;

    const decorators = ts.getDecorators(stmt);
    if (!decorators || decorators.length === 0) continue;

    for (const dec of decorators) {
      if (!ts.isCallExpression(dec.expression)) continue;

      const decoratorName = dec.expression.expression.getText(sourceFile);
      if (!['Component', 'Directive', 'Pipe', 'NgModule'].includes(decoratorName)) continue;

      const args = dec.expression.arguments;
      if (args.length === 0 || !ts.isObjectLiteralExpression(args[0])) continue;

      const obj = args[0] as ts.ObjectLiteralExpression;
      let selector: string | undefined;
      let pipeName: string | undefined;
      let moduleExports: string[] | undefined;

      for (const prop of obj.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key = prop.name.getText(sourceFile).replace(/['"`]/g, '');
        const val = prop.initializer;

        if (key === 'selector' && ts.isStringLiteral(val)) {
          selector = val.text;
        }
        if (key === 'name' && ts.isStringLiteral(val) && decoratorName === 'Pipe') {
          pipeName = val.text;
        }
        if (key === 'exports' && ts.isArrayLiteralExpression(val) && decoratorName === 'NgModule') {
          moduleExports = val.elements
            .filter(ts.isIdentifier)
            .map(e => e.getText(sourceFile));
        }
      }

      if (decoratorName === 'NgModule') {
        entries.push({
          selector: stmt.name.text,
          kind: 'ngmodule',
          exports: moduleExports || [],
          fileName,
          className: stmt.name.text,
        });
      } else if (decoratorName === 'Pipe' && pipeName) {
        entries.push({
          selector: pipeName,
          kind: 'pipe',
          pipeName,
          fileName,
          className: stmt.name.text,
        });
      } else if (selector) {
        entries.push({
          selector: selector.split(',')[0].trim(),
          kind: decoratorName === 'Component' ? 'component' : 'directive',
          fileName,
          className: stmt.name.text,
        });
      }
    }
  }

  return entries;
}
