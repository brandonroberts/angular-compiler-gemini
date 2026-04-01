import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as o from '@angular/compiler';
import MagicString from 'magic-string';
import {
  ConstantPool,
  compileComponentFromMetadata,
  compileDirectiveFromMetadata,
  compilePipeFromMetadata,
  compileNgModule,
  compileInjector,
  R3NgModuleMetadataKind,
  R3SelectorScopeMode,
  FactoryTarget,
  compileFactoryFunction,
  parseTemplate,
  makeBindingParser,
  parseHostBindings,
  ParseSourceFile,
  ParseLocation,
  ParseSourceSpan,
  compileClassMetadata,
} from '@angular/compiler';
import { ComponentRegistry } from './registry';

/** Shared printer — only used as fallback for complex WrappedNodeExpr (e.g. decorator args). */
const sharedPrinter = ts.createPrinter({ removeComments: true });
const emptySourceFile = ts.createSourceFile('_.ts', '', ts.ScriptTarget.Latest, false);

const BINARY_OP_STR: Record<number, string> = {
  [o.BinaryOperator.Equals]: '==', [o.BinaryOperator.NotEquals]: '!=',
  [o.BinaryOperator.Assign]: '=', [o.BinaryOperator.Identical]: '===',
  [o.BinaryOperator.NotIdentical]: '!==', [o.BinaryOperator.Minus]: '-',
  [o.BinaryOperator.Plus]: '+', [o.BinaryOperator.Divide]: '/',
  [o.BinaryOperator.Multiply]: '*', [o.BinaryOperator.Modulo]: '%',
  [o.BinaryOperator.And]: '&&', [o.BinaryOperator.Or]: '||',
  [o.BinaryOperator.BitwiseOr]: '|', [o.BinaryOperator.BitwiseAnd]: '&',
  [o.BinaryOperator.Lower]: '<', [o.BinaryOperator.LowerEquals]: '<=',
  [o.BinaryOperator.Bigger]: '>', [o.BinaryOperator.BiggerEquals]: '>=',
  [o.BinaryOperator.NullishCoalesce]: '??',
  [o.BinaryOperator.Exponentiation]: '**', [o.BinaryOperator.In]: 'in',
  [o.BinaryOperator.AdditionAssignment]: '+=', [o.BinaryOperator.SubtractionAssignment]: '-=',
  [o.BinaryOperator.MultiplicationAssignment]: '*=', [o.BinaryOperator.DivisionAssignment]: '/=',
  [o.BinaryOperator.RemainderAssignment]: '%=', [o.BinaryOperator.ExponentiationAssignment]: '**=',
  [o.BinaryOperator.AndAssignment]: '&&=', [o.BinaryOperator.OrAssignment]: '||=',
  [o.BinaryOperator.NullishCoalesceAssignment]: '??=',
};

/**
 * Emits Angular output AST directly to JavaScript strings, bypassing
 * ts.factory node creation and ts.Printer serialization (~4x faster).
 */
class JSEmitter implements o.ExpressionVisitor, o.StatementVisitor {
  /** Set by compile() so WrappedNodeExpr fallback can print with correct source context. */
  static _currentSourceFile: ts.SourceFile | undefined;

  private emitExpr(e: any): string {
    if (!e) return 'null';
    if (typeof e.visitExpression === 'function') return e.visitExpression(this, null);
    // Angular v21 LiteralMapPropertyAssignment: {key, value, quoted}
    if ('key' in e && 'value' in e) {
      const key = e.quoted ? JSON.stringify(e.key) : e.key;
      return key + ': ' + this.emitExpr(e.value);
    }
    return 'null';
  }
  visitWrappedNodeExpr(ast: o.WrappedNodeExpr<any>) {
    const node = ast.node;
    if (node.kind === ts.SyntaxKind.Identifier) return (node as ts.Identifier).escapedText as string;
    if (node.kind === ts.SyntaxKind.StringLiteral) return JSON.stringify((node as ts.StringLiteral).text);
    if (node.kind === ts.SyntaxKind.NumericLiteral) return (node as ts.NumericLiteral).text;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return 'true';
    if (node.kind === ts.SyntaxKind.FalseKeyword) return 'false';
    if (node.kind === ts.SyntaxKind.NullKeyword) return 'null';
    if (node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) return '`' + (node as ts.NoSubstitutionTemplateLiteral).text + '`';
    // Fallback for complex wrapped nodes (e.g. decorator arguments, array literals).
    // Use currentSourceFile when available for correct position-based printing.
    return sharedPrinter.printNode(ts.EmitHint.Unspecified, node, JSEmitter._currentSourceFile || emptySourceFile);
  }
  visitExternalExpr(ast: o.ExternalExpr) {
    const name = ast.value.name!;
    if (name === 'ngDevMode') return name;
    return 'i0.' + name;
  }
  visitLiteralExpr(ast: o.LiteralExpr) {
    const v = ast.value;
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') return v < 0 ? '(-' + (-v) + ')' : '' + v;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v === undefined) return 'void 0';
    return 'null';
  }
  visitLiteralArrayExpr(ast: o.LiteralArrayExpr) {
    return '[' + ast.entries.map(e => this.emitExpr(e)).join(', ') + ']';
  }
  visitLiteralMapExpr(ast: o.LiteralMapExpr) {
    return '{' + ast.entries.map(e => this.emitExpr(e)).join(', ') + '}';
  }
  visitInvokeFunctionExpr(ast: o.InvokeFunctionExpr) {
    const fn = ast.fn.visitExpression(this, null);
    const args = ast.args.map((a: any) => a.visitExpression(this, null)).join(', ');
    // Wrap arrow/function expressions in parens for valid IIFE syntax
    if (ast.fn instanceof o.ArrowFunctionExpr || ast.fn instanceof o.FunctionExpr) {
      return '(' + fn + ')(' + args + ')';
    }
    return fn + '(' + args + ')';
  }
  visitReadVarExpr(ast: o.ReadVarExpr) {
    if (ast.name === 'this') return 'this';
    if (ast.name === 'super') return 'super';
    return ast.name!;
  }
  visitReadPropExpr(ast: o.ReadPropExpr) { return ast.receiver.visitExpression(this, null) + '.' + ast.name; }
  visitReadKeyExpr(ast: o.ReadKeyExpr) { return ast.receiver.visitExpression(this, null) + '[' + ast.index.visitExpression(this, null) + ']'; }
  visitConditionalExpr(ast: o.ConditionalExpr) { return '(' + ast.condition.visitExpression(this, null) + ' ? ' + ast.trueCase.visitExpression(this, null) + ' : ' + ast.falseCase!.visitExpression(this, null) + ')'; }
  visitBinaryOperatorExpr(ast: o.BinaryOperatorExpr) { return ast.lhs.visitExpression(this, null) + ' ' + (BINARY_OP_STR[ast.operator] || '=') + ' ' + ast.rhs.visitExpression(this, null); }
  visitNotExpr(ast: o.NotExpr) { return '!(' + ast.condition.visitExpression(this, null) + ')'; }
  visitFunctionExpr(ast: o.FunctionExpr) { return '(' + ast.params.map((p: any) => p.name).join(', ') + ') => {' + ast.statements.map((s: any) => s.visitStatement(this, null)).join(' ') + '}'; }
  visitArrowFunctionExpr(ast: o.ArrowFunctionExpr) {
    const params = '(' + ast.params.map((p: any) => p.name).join(', ') + ')';
    if (Array.isArray(ast.body)) return params + ' => {' + ast.body.map((s: any) => s.visitStatement(this, null)).join(' ') + '}';
    return params + ' => ' + (ast.body as o.Expression).visitExpression(this, null);
  }
  visitWriteVarExpr(ast: any) { return ast.name + ' = ' + ast.value.visitExpression(this, null); }
  visitWritePropExpr(ast: any) { return ast.receiver.visitExpression(this, null) + '.' + ast.name + ' = ' + ast.value.visitExpression(this, null); }
  visitWriteKeyExpr(ast: any) { return ast.receiver.visitExpression(this, null) + '[' + ast.index.visitExpression(this, null) + '] = ' + ast.value.visitExpression(this, null); }
  visitInvokeMethodExpr(ast: any) { return ast.receiver.visitExpression(this, null) + '.' + ast.name + '(' + ast.args.map((a: any) => a.visitExpression(this, null)).join(', ') + ')'; }
  visitTypeofExpr(ast: o.TypeofExpr) { return 'typeof ' + ast.expr.visitExpression(this, null); }
  visitUnaryOperatorExpr(ast: o.UnaryOperatorExpr) { return '-(' + ast.expr.visitExpression(this, null) + ')'; }
  visitInstantiateExpr(ast: o.InstantiateExpr) { return 'new (' + ast.classExpr.visitExpression(this, null) + ')(' + ast.args.map((a: any) => a.visitExpression(this, null)).join(', ') + ')'; }
  visitCommaExpr(ast: o.CommaExpr) { return ast.parts.map((p: any) => p.visitExpression(this, null)).join(', '); }
  visitParenthesizedExpr(ast: o.ParenthesizedExpr) { return '(' + ast.expr.visitExpression(this, null) + ')'; }
  visitVoidExpr(ast: o.VoidExpr) { return 'void ' + ast.expr.visitExpression(this, null); }
  visitDynamicImportExpr(ast: o.DynamicImportExpr) { return 'import(' + ast.url.visitExpression(this, null) + ')'; }
  visitTemplateLiteralExpr(ast: o.TemplateLiteralExpr) { return '`' + ast.elements[0].text + ast.expressions.map((e: any, i: number) => '${' + e.visitExpression(this, null) + '}' + ast.elements[i + 1].text).join('') + '`'; }
  visitTaggedTemplateLiteralExpr(ast: any) {
    const elements = ast.template.elements;
    const expressions = ast.template.expressions;
    const head = elements[0].text;
    const spans = expressions.map((e: any, i: number) => '${' + e.visitExpression(this, null) + '}' + elements[i + 1].text).join('');
    return ast.tag.visitExpression(this, null) + '`' + head + spans + '`';
  }
  visitLocalizedString() { throw new Error('i18n not supported'); }
  visitRegularExpressionLiteral(ast: any) { return '/' + (ast.body ?? ast.pattern) + '/' + ast.flags; }
  visitTemplateLiteralElementExpr(ast: o.TemplateLiteralElementExpr) { return JSON.stringify(ast.text); }
  // Statement visitors
  visitReturnStmt(stmt: o.ReturnStatement) { return 'return ' + stmt.value.visitExpression(this, null) + ';'; }
  visitExpressionStmt(stmt: o.ExpressionStatement) { return stmt.expr.visitExpression(this, null) + ';'; }
  visitIfStmt(stmt: o.IfStmt) {
    let s = 'if (' + stmt.condition.visitExpression(this, null) + ') {' + stmt.trueCase.map((s2: any) => s2.visitStatement(this, null)).join(' ') + '}';
    if (stmt.falseCase.length) s += ' else {' + stmt.falseCase.map((s2: any) => s2.visitStatement(this, null)).join(' ') + '}';
    return s;
  }
  visitDeclareVarStmt(stmt: o.DeclareVarStmt) {
    const kw = stmt.hasModifier(o.StmtModifier.Final) ? 'const' : 'let';
    return kw + ' ' + stmt.name + (stmt.value ? ' = ' + stmt.value.visitExpression(this, null) : '') + ';';
  }
  visitDeclareFunctionStmt(stmt: o.DeclareFunctionStmt) { return 'function ' + stmt.name + '(' + stmt.params.map((p: any) => p.name).join(', ') + ') {' + stmt.statements.map((s: any) => s.visitStatement(this, null)).join(' ') + '}'; }
}

const stringEmitter = new JSEmitter();

/** Detect installed Angular major version for compatibility. Supports 19+. */
const ANGULAR_MAJOR = (() => {
  try {
    const { VERSION } = require('@angular/compiler');
    return parseInt(VERSION?.major, 10) || 21;
  } catch {
    return 21;
  }
})();

/**
 * COMPLETE EXHAUSTIVE ANGULAR LITE COMPILER
 * Translates Angular Decorators + Signals to Ivy Static Definitions.
 *
 * @param registry - Optional external registry from the global analysis plugin.
 *   When provided, used to resolve component/directive selectors for template compilation.
 */
export interface CompileResult {
  code: string;
  /** Source map for the transformation */
  map: any;
  /** Absolute paths of external resources (templateUrl, styleUrl) read during compilation */
  resourceDependencies: string[];
}

export interface CompileOptions {
  registry?: ComponentRegistry;
  /** Pre-resolved style contents keyed by absolute file path (e.g. SCSS already compiled to CSS). */
  resolvedStyles?: Map<string, string>;
  /** Pre-processed inline styles (index in styles array → compiled CSS). */
  resolvedInlineStyles?: Map<number, string>;
}

export function compile(sourceCode: string, fileName: string, optionsOrRegistry?: CompileOptions | ComponentRegistry): CompileResult {
  // Backward compat: accept ComponentRegistry directly
  const opts: CompileOptions = optionsOrRegistry instanceof Map ? { registry: optionsOrRegistry } : (optionsOrRegistry || {});
  const registry = opts.registry;
  const resolvedStyles = opts.resolvedStyles;
  const resolvedInlineStyles = opts.resolvedInlineStyles;
  const origSourceFile = ts.createSourceFile(fileName, sourceCode, ts.ScriptTarget.Latest, true);
  const constantPool = new ConstantPool();
  const fileResourceImports: ts.ImportDeclaration[] = [];
  const resourceDependencies: string[] = [];
  const parseFile = new ParseSourceFile(sourceCode, fileName);
  const parseLoc = new ParseLocation(parseFile, 0, 0, 0);
  const typeSourceSpan = new ParseSourceSpan(parseLoc, parseLoc);
  const typeOnlyImports = collectTypeOnlyImports(origSourceFile);

  // Inject 'import * as i0 from "@angular/core"'
  const sourceFile = injectAngularImport(origSourceFile);

  // Build a file-local selector map as fallback when no external registry is provided.
  // Skip the expensive extractMetadata scan when a registry covers all classes.
  const localSelectors = new Map<string, string>();
  if (!registry) {
    sourceFile.statements.forEach(stmt => {
      if (ts.isClassDeclaration(stmt) && stmt.name) {
        const meta = extractMetadata(ts.getDecorators(stmt)?.[0]);
        if (meta?.selector) {
          localSelectors.set(stmt.name.text, meta.selector.split(',')[0].trim());
        }
      }
    });
  }

  const bindingParser = makeBindingParser();
  JSEmitter._currentSourceFile = origSourceFile;

  // --- Direct walk: compile each Angular-decorated class and collect string outputs ---
  // This replaces the previous ts.transform + printer.printNode approach.
  // By emitting strings directly from the Angular output AST, we skip both
  // ts.factory node creation and ts.Printer serialization (~4x faster).
  interface ClassCompileResult {
    ivyCode: string[];       // "static ɵfac = ...", "static ɵcmp = ...", etc.
    decorators: ts.Decorator[];  // Angular decorators to remove
    classEnd: number;        // Position of closing } in original source
  }
  const classResults: ClassCompileResult[] = [];

  const ANGULAR_DECORATORS = new Set(['Component', 'Directive', 'Pipe', 'Injectable', 'NgModule']);

  for (const stmt of origSourceFile.statements) {
    // Handle export declarations wrapping classes
    const node = ts.isExportDeclaration(stmt) ? undefined :
      (ts.isClassDeclaration(stmt) ? stmt : undefined);
    if (!node) continue;

    const decorators = ts.getDecorators(node);
    if (!decorators || decorators.length === 0) continue;

    const className = node.name?.text;
    if (!className) continue;

    const angularDecorators = decorators.filter(dec => {
      if (!ts.isCallExpression(dec.expression)) return false;
      const name = dec.expression.expression.getText(origSourceFile);
      return ANGULAR_DECORATORS.has(name);
    });
    if (angularDecorators.length === 0) continue;

    const ivyCode: string[] = [];
    let targetType: FactoryTarget = FactoryTarget.Injectable;

    const classIdentifier = ts.factory.createIdentifier(className);
    const classRef: o.R3Reference = {
      value: new o.WrappedNodeExpr(classIdentifier),
      type: new o.WrappedNodeExpr(classIdentifier)
    };

    angularDecorators.forEach(dec => {
      const decoratorName = (dec.expression as ts.CallExpression).expression.getText(origSourceFile);
      const meta = extractMetadata(dec);
      const sigs = detectSignals(node);
      const fields = detectFieldDecorators(node);
      const hostBindings = parseHostBindings(meta.hostRaw || {});

      const hostMetadata: o.R3HostMetadata = {
        attributes: hostBindings.attributes,
        listeners: { ...hostBindings.listeners, ...fields.hostListeners },
        properties: { ...hostBindings.properties, ...fields.hostProperties },
        specialAttributes: hostBindings.specialAttributes
      };

      switch (decoratorName) {
        case 'Component':
          targetType = FactoryTarget.Component;
          processResources();
          if (!meta.selector) {
            meta.selector = `ng-component-${className.toLowerCase()}`;
          }

          const declarations: any[] = [];
          for (const dep of (Array.isArray(meta.imports) ? meta.imports : [])) {
            const depClassName = dep.node.getText();
            const registryEntry = registry?.get(depClassName);

            if (registryEntry?.kind === 'ngmodule' && registryEntry.exports) {
              for (const exportedName of registryEntry.exports) {
                const exportedEntry = registry?.get(exportedName);
                if (exportedEntry && exportedEntry.kind !== 'ngmodule') {
                  const kind = exportedEntry.kind === 'pipe' ? 1 : 0;
                  declarations.push({
                    type: dep,
                    selector: exportedEntry.selector,
                    kind,
                    ...(kind === 1 ? { name: exportedEntry.pipeName } : {})
                  });
                }
              }
              continue;
            }

            const selector = registryEntry?.selector ?? localSelectors.get(depClassName);
            const kind = registryEntry?.kind === 'pipe' ? 1 : 0;
            declarations.push({
              type: dep,
              selector: selector || `_unresolved-${depClassName}`,
              kind,
              ...(kind === 1 ? { name: registryEntry?.pipeName } : {})
            });
          }

          let templateContent = meta.template || '';
          if (!templateContent && meta.templateUrl) {
            try {
              const templatePath = path.resolve(path.dirname(fileName), meta.templateUrl);
              templateContent = fs.readFileSync(templatePath, 'utf-8');
              resourceDependencies.push(templatePath);
            } catch {
              console.warn(`[angular-compiler] Could not read template file "${meta.templateUrl}" for ${className}`);
            }
          }

          if (Array.isArray(meta.styleUrls)) {
            for (const url of meta.styleUrls) {
              try {
                const stylePath = path.resolve(path.dirname(fileName), url);
                const styleContent = resolvedStyles?.get(stylePath)
                  ?? fs.readFileSync(stylePath, 'utf-8');
                meta.styles.push(styleContent);
                resourceDependencies.push(stylePath);
              } catch {
                console.warn(`[angular-compiler] Could not read style file "${url}" for ${className}`);
              }
            }
          }

          if (resolvedInlineStyles) {
            for (const [idx, css] of resolvedInlineStyles) {
              if (idx < meta.styles.length) {
                meta.styles[idx] = css;
              }
            }
          }

          const parsedTemplate = parseTemplate(templateContent, fileName, { preserveWhitespaces: meta.preserveWhitespaces });

          const ivyInputs: Record<string, any> = {};
          if (Array.isArray(meta.inputs)) {
            meta.inputs.forEach((i: string) => ivyInputs[i] = i);
          } else if (meta.inputs) {
            Object.assign(ivyInputs, meta.inputs);
          }
          Object.assign(ivyInputs, fields.inputs);
          for (const [key, val] of Object.entries(sigs.inputs)) {
            const sigDesc = val as any;
            ivyInputs[key] = {
              classPropertyName: key,
              bindingPropertyName: key,
              isSignal: true,
              required: sigDesc.required || false,
              transformFunction: sigDesc.transform || null,
            };
          }
          if (parsedTemplate.errors) {
            console.log(parsedTemplate.errors);
            return '' as any;
          }

          const componentMeta: any = {
            ...meta,
            name: className,
            type: classRef,
            typeSourceSpan,
            declarations,
            template: {
              nodes: parsedTemplate.nodes,
              ngContentSelectors: parsedTemplate.ngContentSelectors,
              preserveWhitespaces: parsedTemplate.preserveWhitespaces
            },
            styles: meta.styles,
            inputs: ivyInputs,
            outputs: { ...meta.outputs, ...fields.outputs, ...sigs.outputs },
            viewQueries: [...fields.viewQueries, ...sigs.viewQueries],
            queries: [...fields.contentQueries, ...sigs.contentQueries],
            host: hostMetadata,
            changeDetection: meta.changeDetection,
            encapsulation: meta.encapsulation,
            exportAs: meta.exportAs,
            providers: meta.providers?.length ? new o.LiteralArrayExpr(meta.providers) : null,
            viewProviders: meta.viewProviders?.length ? new o.LiteralArrayExpr(meta.viewProviders) : null,
            animations: meta.animations?.length ? new o.LiteralArrayExpr(meta.animations) : null,
            isStandalone: meta.standalone,
            imports: meta.imports,
            lifecycle: { usesOnChanges: false },
            defer: {
              mode: 0,
              blocks: buildDeferDependencyMap(parsedTemplate, sourceFile, registry, localSelectors).blocks,
            },
            declarationListEmitMode: 0,
            relativeContextFilePath: fileName,
            controlCreate: null,
          };

          if (ANGULAR_MAJOR >= 20) {
            componentMeta.hasDirectiveDependencies = declarations.length > 0;
          }

          const cmp = compileComponentFromMetadata(componentMeta, constantPool, bindingParser);
          ivyCode.push(`static ɵcmp = ${emitAngularExpr(cmp.expression)}`);
          break;

        case 'Directive':
          targetType = FactoryTarget.Directive;
          const dir = compileDirectiveFromMetadata({
            ...meta, name: className, type: classRef, typeSourceSpan, host: hostMetadata,
            inputs: { ...meta.inputs, ...fields.inputs, ...sigs.inputs },
            outputs: { ...meta.outputs, ...fields.outputs, ...sigs.outputs },
            viewQueries: [...fields.viewQueries, ...sigs.viewQueries],
            queries: [...fields.contentQueries, ...sigs.contentQueries],
            providers: meta.providers, exportAs: meta.exportAs, isStandalone: meta.standalone,
            lifecycle: { usesOnChanges: false },
          }, constantPool, bindingParser);
          ivyCode.push(`static ɵdir = ${emitAngularExpr(dir.expression)}`);
          break;

        case 'Pipe':
          targetType = FactoryTarget.Pipe;
          const pipe = compilePipeFromMetadata({
            ...meta, name: className, pipeName: meta.name, type: classRef,
            isStandalone: meta.standalone, pure: meta.pure ?? true
          });
          ivyCode.push(`static ɵpipe = ${emitAngularExpr(pipe.expression)}`);
          break;

              case 'Injectable':
                targetType = FactoryTarget.Injectable;
                const inj = o.compileInjectable({
                  name: className,
                  type: classRef,
                  typeArgumentCount: 0,
                  providedIn: {
                    expression: new o.LiteralExpr(meta.providedIn || 'root'),
                    forwardRef: 0
                  },
                }, true);
                ivyCode.push(`static ɵprov = ${emitAngularExpr(inj.expression)}`);
                break;

              case 'NgModule':
                targetType = FactoryTarget.NgModule;
                const ngModuleImports = Array.isArray(meta.imports) ? meta.imports : [];
                const ngModuleDeclarations = Array.isArray(meta.declarations) ? meta.declarations : [];
                const ngModuleExports = Array.isArray(meta.exports) ? meta.exports : [];
                const ngModuleBootstrap = Array.isArray(meta.bootstrap) ? meta.bootstrap : [];

                const ngMod = compileNgModule({
                  kind: R3NgModuleMetadataKind.Global,
                  type: classRef,
                  bootstrap: ngModuleBootstrap.map((e: o.WrappedNodeExpr<any>) => ({ value: e, type: e })),
                  declarations: ngModuleDeclarations.map((e: o.WrappedNodeExpr<any>) => ({ value: e, type: e })),
                  publicDeclarationTypes: null,
                  imports: ngModuleImports.map((e: o.WrappedNodeExpr<any>) => ({ value: e, type: e })),
                  includeImportTypes: true,
                  exports: ngModuleExports.map((e: o.WrappedNodeExpr<any>) => ({ value: e, type: e })),
                  selectorScopeMode: R3SelectorScopeMode.Inline,
                  containsForwardDecls: false,
                  schemas: [],
                  id: null,
                });
                ivyCode.push(`static ɵmod = ${emitAngularExpr(ngMod.expression)}`);

                const injector = compileInjector({
                  name: className,
                  type: classRef,
                  providers: meta.providers ? new o.LiteralArrayExpr(meta.providers) : null,
                  imports: ngModuleImports.map((e: o.WrappedNodeExpr<any>) => e),
                });
                ivyCode.push(`static ɵinj = ${emitAngularExpr(injector.expression)}`);
                break;
            }
          });

          // Generate factory
          const deps = extractConstructorDeps(node, typeOnlyImports);
          if (deps === null) {
            const baseVar = `ɵ${className}_BaseFactory`;
            ivyCode.unshift(`static ɵfac = /*@__PURE__*/ (() => { let ${baseVar}; return function ${className}_Factory(__ngFactoryType__) { return (${baseVar} || (${baseVar} = i0.ɵɵgetInheritedFactory(${className})))(__ngFactoryType__ || ${className}); }; })()`);
          } else if (deps === 'invalid') {
            ivyCode.unshift(`static ɵfac = function ${className}_Factory(__ngFactoryType__) { i0.ɵɵinvalidFactory(); }`);
          } else {
            const fac = compileFactoryFunction({
              name: className,
              type: classRef,
              typeArgumentCount: 0,
              deps,
              target: targetType,
            });
            ivyCode.unshift(`static ɵfac = ${emitAngularExpr(fac.expression)}`);
          }

          // Emit setClassMetadata for runtime decorator reflection (devMode only)
          angularDecorators.forEach(dec => {
            const call = dec.expression as ts.CallExpression;
            const decName = call.expression.getText(origSourceFile);
            const decArgsNode = call.arguments[0];

            try {
              const classMetadataExpr = compileClassMetadata({
                type: new o.WrappedNodeExpr(ts.factory.createIdentifier(className)),
                decorators: new o.LiteralArrayExpr([
                  new o.LiteralMapExpr([
                    { key: 'type', value: new o.WrappedNodeExpr(ts.factory.createIdentifier(decName)), quoted: false },
                    ...(decArgsNode ? [{ key: 'args', value: new o.LiteralArrayExpr([new o.WrappedNodeExpr(decArgsNode)]), quoted: false }] : []),
                  ])
                ]),
                ctorParameters: null,
                propDecorators: null,
              });
              constantPool.statements.push(new o.ExpressionStatement(classMetadataExpr));
            } catch {
              // Skip if compileClassMetadata fails
            }
          });

          classResults.push({
            ivyCode,
            decorators: angularDecorators,
            classEnd: node.getEnd(),
          });
  }

  // Apply edits via MagicString
  const ms = new MagicString(sourceCode, { filename: fileName });

  // 1. Prepend i0 import
  ms.prepend('import * as i0 from "@angular/core";\n');

  // 2. For each compiled class: remove decorators + insert Ivy definitions
  for (const cr of classResults) {
    // Remove Angular decorators from source
    for (const dec of cr.decorators) {
      const start = dec.getStart(origSourceFile);
      const end = dec.getEnd();
      let trimEnd = end;
      while (trimEnd < sourceCode.length && (sourceCode[trimEnd] === ' ' || sourceCode[trimEnd] === '\n' || sourceCode[trimEnd] === '\r')) {
        trimEnd++;
      }
      ms.remove(start, trimEnd);
    }

    // Insert static members before closing }
    if (cr.ivyCode.length > 0) {
      const memberCode = cr.ivyCode.map(c => '  ' + c + ';').join('\n');
      ms.appendLeft(cr.classEnd - 1, '\n' + memberCode + '\n');
    }
  }

  // 3. Append constant pool statements (setClassMetadata, etc.)
  const constants = constantPool.statements.map(s => emitAngularStmt(s)).join('\n');
  if (constants) {
    ms.append('\n\n' + constants);
  }

  const map = ms.generateMap({
    source: fileName,
    file: fileName + '.js',
    includeContent: true,
    hires: 'boundary',
  });

  return {
    code: ms.toString(),
    map,
    resourceDependencies,
  };
}

/** Emit Angular output AST expression directly to a JavaScript string. */
function emitAngularExpr(expr: o.Expression): string {
  return expr.visitExpression(stringEmitter, null);
}

/** Emit Angular output AST statement directly to a JavaScript string. */
function emitAngularStmt(stmt: o.Statement): string {
  return stmt.visitStatement(stringEmitter, null);
}

/** * METADATA & RESOURCE HELPERS
 */
function extractMetadata(dec: ts.Decorator | undefined): any {
  if (!dec) return null;
  const call = dec.expression as ts.CallExpression;
  const obj = call.arguments[0] as ts.ObjectLiteralExpression;
  const meta: any = { hostRaw: {}, inputs: {}, outputs: {}, standalone: true, imports: [], providers: null, viewProviders: null, animations: null, changeDetection: 1, encapsulation: 0, preserveWhitespaces: false, exportAs: null, selector: undefined, styles: [], templateUrl: null, styleUrls: [] };
  if (!obj) return meta;
  obj.properties.forEach(p => {
    if (!ts.isPropertyAssignment(p)) return;
    const key = p.name.getText().replace(/['"`]/g, ''), valNode = p.initializer, valText = valNode.getText();
    switch (key) {
      case 'host': if (ts.isObjectLiteralExpression(valNode)) valNode.properties.forEach(hp => { if (ts.isPropertyAssignment(hp)) meta.hostRaw[hp.name.getText().replace(/['"`]/g, '')] = hp.initializer.getText().replace(/['"`]/g, ''); }); break;
      case 'changeDetection': meta.changeDetection = valText.includes('OnPush') ? 0 : 1; break;
      case 'encapsulation': meta.encapsulation = valText.includes('None') ? 2 : (valText.includes('ShadowDom') ? 3 : 0); break;
      case 'preserveWhitespaces': meta.preserveWhitespaces = valText === 'true'; break;
      case 'pure': case 'standalone': meta[key] = valText !== 'false'; break;
      case 'template': case 'selector': case 'name': case 'exportAs': case 'templateUrl': case 'providedIn':
        // Extract the actual string content, preserving internal quotes
        if (ts.isStringLiteral(valNode) || ts.isNoSubstitutionTemplateLiteral(valNode)) {
          meta[key] = valNode.text;
        } else {
          meta[key] = valText.replace(/['"`]/g, '');
        }
        if (key === 'exportAs') meta.exportAs = [meta.exportAs];
        break;
      case 'styleUrl':
        // Angular supports singular styleUrl as shorthand
        if (ts.isStringLiteral(valNode) || ts.isNoSubstitutionTemplateLiteral(valNode)) {
          meta.styleUrls = [valNode.text];
        } else {
          meta.styleUrls = [valText.replace(/['"`]/g, '')];
        }
        break;
      case 'styleUrls': if (ts.isArrayLiteralExpression(valNode)) meta.styleUrls = valNode.elements.map(e => ts.isStringLiteral(e) ? e.text : e.getText().replace(/['"`]/g, '')); break;
      case 'styles':
        if (ts.isArrayLiteralExpression(valNode)) {
          meta.styles = valNode.elements.map(e => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : e.getText().replace(/['"`]/g, ''));
        } else if (ts.isStringLiteral(valNode) || ts.isNoSubstitutionTemplateLiteral(valNode)) {
          // Angular supports singular styles as a string
          meta.styles = [valNode.text];
        }
        break;
      case 'imports': case 'providers': case 'viewProviders': case 'animations': case 'rawImports': case 'declarations': case 'exports': case 'bootstrap': if (ts.isArrayLiteralExpression(valNode)) meta[key] = valNode.elements.map(e => new o.WrappedNodeExpr(unwrapForwardRef(e as ts.Expression))); break;
      default: meta[key] = valText.replace(/['"`]/g, '');
    }
  });
  return meta;
}

/** Resources are read and inlined at compile time — no imports needed. */
function processResources() {
  return { imports: [] as ts.ImportDeclaration[] };
}

function detectSignals(node: ts.ClassDeclaration) {
  const inputs: any = {}, outputs: any = {}, viewQueries: any[] = [], contentQueries: any[] = [];
  
  node.members.forEach(m => {
    if (ts.isPropertyDeclaration(m) && m.initializer && ts.isCallExpression(m.initializer)) {
      const name = m.name.getText();
      const callExpr = m.initializer.expression.getText();

      // 1. SIGNAL INPUTS (Standard & Required)
      if (callExpr.includes('input')) {
        const isRequired = callExpr.includes('.required');
        // Extract transform from options: input(val, { transform }) or input.required({ transform })
        let transform: any = null;
        const optionsArg = isRequired ? m.initializer.arguments[0] : m.initializer.arguments[1];
        if (optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
          for (const prop of optionsArg.properties) {
            if (ts.isPropertyAssignment(prop) && prop.name.getText() === 'transform') {
              transform = new o.WrappedNodeExpr(prop.initializer);
            }
          }
        }
        inputs[name] = {
          classPropertyName: name,
          bindingPropertyName: name,
          isSignal: true,
          required: isRequired,
          transform,
        };
      }

      // 2. MODEL SIGNALS (Writable Inputs)
      else if (callExpr.includes('model')) {
        // Models are signals (flag 3) and generate an automatic output
        inputs[name] = {
          classPropertyName: name,
          bindingPropertyName: name,
          isSignal: true
        };
        outputs[name + 'Change'] = name + 'Change';
      }

      // 3. SIGNAL QUERIES (viewChild, contentChild)
      else if (callExpr.includes('Child') || callExpr.includes('Children')) {
        const isSignalQuery = callExpr.includes('viewChild') || 
                             callExpr.includes('contentChild') || 
                             callExpr.includes('viewChildren') || 
                             callExpr.includes('contentChildren');
        
        const query = {
          propertyName: name,
          predicate: ts.isStringLiteral(m.initializer.arguments[0]) 
            ? [m.initializer.arguments[0].text] 
            : new o.WrappedNodeExpr(m.initializer.arguments[0]),
          first: !callExpr.includes('ren'), // Children vs Child
          descendants: true,
          read: null,
          static: false,
          emitFlags: 0,
          isSignal: isSignalQuery // Critical for v21 query reactivity
        };

        if (callExpr.includes('view')) viewQueries.push(query); 
        else contentQueries.push(query);
      }

      // 4. STANDARD OUTPUTS
      else if (callExpr.includes('output')) {
        outputs[name] = name;
      }
    }
  });

  return { inputs, outputs, viewQueries, contentQueries };
}

/**
 * Detect decorator-based field metadata: @Input, @Output, @ViewChild,
 * @ContentChild, @ViewChildren, @ContentChildren, @HostBinding, @HostListener.
 */
function detectFieldDecorators(node: ts.ClassDeclaration) {
  const inputs: any = {};
  const outputs: any = {};
  const viewQueries: any[] = [];
  const contentQueries: any[] = [];
  const hostProperties: Record<string, string> = {};
  const hostListeners: Record<string, string> = {};

  for (const member of node.members) {
    const decorators = ts.getDecorators(member);
    if (!decorators) continue;

    const memberName = member.name?.getText() || '';

    for (const dec of decorators) {
      if (!ts.isCallExpression(dec.expression)) continue;
      const decName = dec.expression.expression.getText();
      const args = dec.expression.arguments;

      switch (decName) {
        case 'Input': {
          let bindingName = memberName;
          let required = false;
          let transformFunction: any = null;

          if (args.length > 0) {
            const arg = args[0];
            if (ts.isStringLiteral(arg)) {
              bindingName = arg.text;
            } else if (ts.isObjectLiteralExpression(arg)) {
              for (const prop of arg.properties) {
                if (!ts.isPropertyAssignment(prop)) continue;
                const key = prop.name.getText();
                if (key === 'alias' && ts.isStringLiteral(prop.initializer)) bindingName = prop.initializer.text;
                if (key === 'required') required = prop.initializer.getText() === 'true';
                if (key === 'transform') transformFunction = new o.WrappedNodeExpr(prop.initializer);
              }
            }
          }

          inputs[memberName] = {
            classPropertyName: memberName,
            bindingPropertyName: bindingName,
            isSignal: false,
            required,
            transformFunction,
          };
          break;
        }

        case 'Output': {
          const alias = args.length > 0 && ts.isStringLiteral(args[0]) ? args[0].text : memberName;
          outputs[memberName] = alias;
          break;
        }

        case 'ViewChild': case 'ViewChildren': case 'ContentChild': case 'ContentChildren': {
          const isView = decName.startsWith('View');
          const isFirst = decName === 'ViewChild' || decName === 'ContentChild';

          let predicate: any = memberName;
          if (args.length > 0) {
            const pred = args[0];
            if (ts.isStringLiteral(pred)) {
              predicate = [pred.text];
            } else {
              predicate = new o.WrappedNodeExpr(unwrapForwardRef(pred as ts.Expression));
            }
          }

          let read: any = null;
          let isStatic = false;
          let descendants = isView || isFirst; // ContentChildren defaults to false

          if (args.length > 1 && ts.isObjectLiteralExpression(args[1])) {
            for (const prop of (args[1] as ts.ObjectLiteralExpression).properties) {
              if (!ts.isPropertyAssignment(prop)) continue;
              const key = prop.name.getText();
              if (key === 'read') read = new o.WrappedNodeExpr(prop.initializer);
              if (key === 'static') isStatic = prop.initializer.getText() === 'true';
              if (key === 'descendants') descendants = prop.initializer.getText() === 'true';
            }
          }

          const query = {
            propertyName: memberName,
            predicate,
            first: isFirst,
            descendants,
            read,
            static: isStatic,
            emitFlags: 0,
            isSignal: false,
          };

          if (isView) viewQueries.push(query);
          else contentQueries.push(query);
          break;
        }

        case 'HostBinding': {
          const target = args.length > 0 && ts.isStringLiteral(args[0]) ? args[0].text : memberName;
          hostProperties[target] = memberName;
          break;
        }

        case 'HostListener': {
          if (args.length > 0 && ts.isStringLiteral(args[0])) {
            const event = args[0].text;
            let handler = `${memberName}()`;
            if (args.length > 1 && ts.isArrayLiteralExpression(args[1])) {
              const handlerArgs = args[1].elements
                .filter(ts.isStringLiteral)
                .map(e => e.text)
                .join(', ');
              handler = `${memberName}(${handlerArgs})`;
            }
            hostListeners[event] = handler;
          }
          break;
        }
      }
    }
  }

  return { inputs, outputs, viewQueries, contentQueries, hostProperties, hostListeners };
}

/** Recursively collect all DeferredBlock nodes from a template AST. */
function collectDeferBlocks(nodes: any[]): any[] {
  const result: any[] = [];
  function walk(node: any) {
    if (!node) return;
    if (node.constructor?.name === 'DeferredBlock') {
      result.push(node);
    }
    // Walk all possible child structures across block types:
    // Element/Template: children
    // IfBlock: branches (each has children)
    // ForLoopBlock: children, empty (has children)
    // SwitchBlock: cases (each has children)
    // DeferredBlock: children, placeholder/loading/error (each has children)
    if (Array.isArray(node.children)) node.children.forEach(walk);
    if (Array.isArray(node.branches)) node.branches.forEach(walk);
    if (Array.isArray(node.cases)) node.cases.forEach(walk);
    if (node.empty?.children) node.empty.children.forEach(walk);
    if (node.placeholder?.children) node.placeholder.children.forEach(walk);
    if (node.loading?.children) node.loading.children.forEach(walk);
    if (node.error?.children) node.error.children.forEach(walk);
  }
  nodes.forEach(walk);
  return result;
}

/** Collect element tag names from template AST nodes recursively. */
function collectElementNames(nodes: any[]): Set<string> {
  const result = new Set<string>();
  function walk(node: any) {
    if (!node) return;
    if (node.constructor?.name === 'Element') result.add(node.name);
    if (Array.isArray(node.children)) node.children.forEach(walk);
    if (Array.isArray(node.branches)) node.branches.forEach(walk);
    if (Array.isArray(node.cases)) node.cases.forEach(walk);
    if (node.empty?.children) node.empty.children.forEach(walk);
  }
  nodes.forEach(walk);
  return result;
}

/** Build import path map: className → modulePath from source file imports. */
function buildImportMap(sf: ts.SourceFile): Map<string, string> {
  const result = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const modulePath = (stmt.moduleSpecifier as ts.StringLiteral).text;
    const clause = stmt.importClause;
    if (clause.name) result.set(clause.name.text, modulePath);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        result.set(el.name.text, modulePath);
      }
    }
  }
  return result;
}

/**
 * Build defer block dependency map with dynamic import() expressions.
 *
 * For each defer block, identifies which imported components are only used
 * inside defer blocks (not in the eager template), and generates dynamic
 * import expressions for lazy loading.
 *
 * Returns:
 * - blocks: Map<DeferredBlock, Expression | null> for compileComponentFromMetadata
 * - deferredImports: Set<string> of class names that should be removed from static imports
 */
function buildDeferDependencyMap(
  parsedTemplate: any,
  sourceFile: ts.SourceFile,
  registry: ComponentRegistry | undefined,
  localSelectors: Map<string, string>,
): { blocks: Map<any, any>, deferredImports: Set<string> } {
  const deferBlocks = collectDeferBlocks(parsedTemplate.nodes);
  if (deferBlocks.length === 0) {
    return { blocks: new Map(), deferredImports: new Set() };
  }

  // Collect all element names in eager (non-defer) template parts
  const allElements = collectElementNames(parsedTemplate.nodes);
  const deferElements = new Set<string>();
  for (const block of deferBlocks) {
    const elements = collectElementNames(block.children || []);
    for (const el of elements) deferElements.add(el);
  }
  // Eager elements = all elements minus those only in defer blocks
  // (An element is eager if it appears anywhere outside defer blocks too)
  // Simple approach: collect elements from non-defer top-level nodes
  const eagerElements = new Set<string>();
  for (const node of parsedTemplate.nodes) {
    if (node.constructor?.name !== 'DeferredBlock') {
      const names = collectElementNames([node]);
      for (const n of names) eagerElements.add(n);
    }
  }

  // Build selector → className map from registry + local selectors
  const selectorToClass = new Map<string, string>();
  if (registry) {
    for (const [className, entry] of registry) {
      if (entry.selector) selectorToClass.set(entry.selector, className);
    }
  }
  for (const [className, selector] of localSelectors) {
    selectorToClass.set(selector, className);
  }

  // Build className → importPath map
  const importMap = buildImportMap(sourceFile);

  // Find defer-only component class names
  const deferredImports = new Set<string>();
  const deferOnlyElements = new Set<string>();
  for (const el of deferElements) {
    if (!eagerElements.has(el)) deferOnlyElements.add(el);
  }

  for (const el of deferOnlyElements) {
    const className = selectorToClass.get(el);
    if (className && importMap.has(className)) {
      deferredImports.add(className);
    }
  }

  // Build the blocks map with dependency functions
  const blocks = new Map<any, any>();
  for (const block of deferBlocks) {
    const blockElements = collectElementNames(block.children || []);
    const blockDeps: any[] = [];

    for (const el of blockElements) {
      const className = selectorToClass.get(el);
      if (className && deferredImports.has(className)) {
        const modulePath = importMap.get(className)!;
        // () => import('./path').then(m => m.ClassName)
        blockDeps.push(
          new o.ArrowFunctionExpr([],
            new o.DynamicImportExpr(new o.LiteralExpr(modulePath))
          )
        );
      }
    }

    if (blockDeps.length > 0) {
      // () => [import('./a').then(...), import('./b').then(...)]
      blocks.set(block, new o.ArrowFunctionExpr([], new o.LiteralArrayExpr(blockDeps)));
    } else {
      blocks.set(block, null);
    }
  }

  return { blocks, deferredImports };
}

/** Collect type-only imported names: `import type { X }` and `import { type X }`. */
function collectTypeOnlyImports(sf: ts.SourceFile): Set<string> {
  const result = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const clause = stmt.importClause;
    if (clause.isTypeOnly) {
      // import type { X, Y } from '...'
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) result.add(el.name.text);
      }
      if (clause.name) result.add(clause.name.text);
    } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      // import { type X, Y } from '...'
      for (const el of clause.namedBindings.elements) {
        if (el.isTypeOnly) result.add(el.name.text);
      }
    }
  }
  return result;
}

/**
 * Analyze constructor parameters for dependency injection.
 * Returns:
 * - R3DependencyMetadata[] for normal constructors
 * - null if class extends another without own constructor (use inherited factory)
 * - 'invalid' if any parameter has a type-only import token
 */
function extractConstructorDeps(node: ts.ClassDeclaration, typeOnlyImports: Set<string>): any[] | 'invalid' | null {
  const hasSuper = node.heritageClauses?.some(h => h.token === ts.SyntaxKind.ExtendsKeyword);
  const ctor = node.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration | undefined;

  if (!ctor) {
    return hasSuper ? null : []; // Inherited factory or zero-arg
  }

  const deps: any[] = [];
  let invalid = false;

  for (const param of ctor.parameters) {
    let token: string | null = null;
    let attributeNameType: any = null;
    let host = false, optional = false, self = false, skipSelf = false;

    // Extract type annotation as token
    if (param.type && ts.isTypeReferenceNode(param.type)) {
      token = param.type.typeName.getText();
    } else if (param.type && ts.isUnionTypeNode(param.type)) {
      // Handle `Service | null` — find first TypeReference
      for (const t of param.type.types) {
        if (ts.isTypeReferenceNode(t)) { token = t.typeName.getText(); break; }
      }
    }

    // Process parameter decorators
    const paramDecorators = ts.getDecorators(param);
    if (paramDecorators) {
      for (const dec of paramDecorators) {
        if (!ts.isCallExpression(dec.expression)) continue;
        const decName = dec.expression.expression.getText();
        const args = dec.expression.arguments;

        switch (decName) {
          case 'Inject':
            if (args.length > 0) {
              if (ts.isStringLiteral(args[0])) {
                token = args[0].text;
              } else {
                token = args[0].getText();
              }
            }
            break;
          case 'Optional': optional = true; break;
          case 'Self': self = true; break;
          case 'SkipSelf': skipSelf = true; break;
          case 'Host': host = true; break;
          case 'Attribute':
            if (args.length > 0 && ts.isStringLiteral(args[0])) {
              attributeNameType = new o.LiteralExpr(args[0].text);
              token = ''; // Attribute injection has no class token
            }
            break;
        }
      }
    }

    if (!token && !attributeNameType) {
      invalid = true;
      continue;
    }

    if (token && typeOnlyImports.has(token)) {
      invalid = true;
      continue;
    }

    deps.push({
      token: token ? new o.WrappedNodeExpr(ts.factory.createIdentifier(token)) : new o.LiteralExpr(null),
      attributeNameType,
      host,
      optional,
      self,
      skipSelf,
    });
  }

  return invalid ? 'invalid' : deps;
}

/**
 * Unwrap forwardRef(() => X) to X. Returns the original node if not a forwardRef call.
 */
function unwrapForwardRef(node: ts.Expression): ts.Expression {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'forwardRef') {
    const arg = node.arguments[0];
    if (arg && ts.isArrowFunction(arg)) {
      if (ts.isBlock(arg.body)) {
        // forwardRef(function() { return X; }) or forwardRef(() => { return X; })
        const stmt = arg.body.statements[0];
        if (stmt && ts.isReturnStatement(stmt) && stmt.expression) return stmt.expression;
      } else {
        // forwardRef(() => X)
        return arg.body;
      }
    }
    if (arg && ts.isFunctionExpression(arg) && arg.body.statements.length === 1) {
      const stmt = arg.body.statements[0];
      if (ts.isReturnStatement(stmt) && stmt.expression) return stmt.expression;
    }
  }
  return node;
}

function injectAngularImport(sf: ts.SourceFile) { return ts.factory.updateSourceFile(sf, [ts.factory.createImportDeclaration(undefined, ts.factory.createImportClause(false, undefined, ts.factory.createNamespaceImport(ts.factory.createIdentifier('i0'))), ts.factory.createStringLiteral('@angular/core')), ...sf.statements]); }
function createStaticProperty(n: string, i: ts.Expression) { return ts.factory.createPropertyDeclaration([ts.factory.createModifier(ts.SyntaxKind.StaticKeyword)], n, undefined, undefined, i); }