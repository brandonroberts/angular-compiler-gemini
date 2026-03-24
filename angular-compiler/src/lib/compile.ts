import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import * as o from '@angular/compiler';
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
} from '@angular/compiler';
import { AstTranslator } from './ast-translator';
import { ComponentRegistry } from './registry';

const translator = new AstTranslator();

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
export function compile(sourceCode: string, fileName: string, registry?: ComponentRegistry): string {
  let sourceFile = ts.createSourceFile(fileName, sourceCode, ts.ScriptTarget.Latest, true);
  const constantPool = new ConstantPool();
  const fileResourceImports: ts.ImportDeclaration[] = [];
  const parseFile = new ParseSourceFile(sourceCode, fileName);
  const parseLoc = new ParseLocation(parseFile, 0, 0, 0);
  const typeSourceSpan = new ParseSourceSpan(parseLoc, parseLoc);

  // Inject 'import * as i0 from "@angular/core"'
  sourceFile = injectAngularImport(sourceFile);

  // Build a file-local selector map as fallback when no external registry is provided
  const localSelectors = new Map<string, string>();
  sourceFile.statements.forEach(stmt => {
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      const meta = extractMetadata(ts.getDecorators(stmt)?.[0]);
      if (meta?.selector) {
        localSelectors.set(stmt.name.text, meta.selector.split(',')[0].trim());
      }
    }
  });

  const bindingParser = makeBindingParser();

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    return (rootNode) => {
      let anonCounter = 0;
      const visitor = (node: ts.Node): ts.Node => {
        if (ts.isClassDeclaration(node)) {
          const className = node.name?.text || `_AnonymousClass${anonCounter++}`;
          const decorators = ts.getDecorators(node);
          if (!decorators || decorators.length === 0) return ts.visitEachChild(node, visitor, context);

          const ANGULAR_DECORATORS = ['Component', 'Directive', 'Pipe', 'Injectable', 'NgModule'];
          const angularDecorators = decorators.filter(dec => {
            if (!ts.isCallExpression(dec.expression)) return false;
            const name = dec.expression.expression.getText();
            return ANGULAR_DECORATORS.includes(name);
          });

          // Skip classes that have no Angular decorators
          if (angularDecorators.length === 0) return ts.visitEachChild(node, visitor, context);

          let ivyProps: ts.ClassElement[] = [];
          let targetType: FactoryTarget = FactoryTarget.Injectable;

          const classIdentifier = ts.factory.createIdentifier(className);
          const classRef: o.R3Reference = {
            value: new o.WrappedNodeExpr(classIdentifier),
            type: new o.WrappedNodeExpr(classIdentifier)
          };

          angularDecorators.forEach(dec => {
            const decoratorName = (dec.expression as ts.CallExpression).expression.getText();
            const meta = extractMetadata(dec);
            const sigs = detectSignals(node);
            const hostBindings = parseHostBindings(meta.hostRaw || {});

            const hostMetadata: o.R3HostMetadata = {
              attributes: hostBindings.attributes,
              listeners: hostBindings.listeners,
              properties: hostBindings.properties,
              specialAttributes: hostBindings.specialAttributes
            };

            switch (decoratorName) {
              case 'Component':
                targetType = FactoryTarget.Component;
                processResources();

                // Resolve component dependencies by looking up selectors from the registry.
                // The global analysis plugin provides the registry; falls back to file-local scan.
                // NgModule imports are expanded to their exported declarations.
                const declarations: any[] = [];
                for (const dep of (Array.isArray(meta.imports) ? meta.imports : [])) {
                  const depClassName = dep.node.getText();
                  const registryEntry = registry?.get(depClassName);

                  // If importing an NgModule, expand its exports into individual declarations
                  if (registryEntry?.kind === 'ngmodule' && registryEntry.exports) {
                    for (const exportedName of registryEntry.exports) {
                      const exportedEntry = registry?.get(exportedName);
                      if (exportedEntry && exportedEntry.kind !== 'ngmodule') {
                        const kind = exportedEntry.kind === 'pipe' ? 1 : 0;
                        declarations.push({
                          type: dep, // Reference the NgModule (Angular resolves at runtime)
                          selector: exportedEntry.selector,
                          kind,
                          ...(kind === 1 ? { name: exportedEntry.pipeName } : {})
                        });
                      }
                    }
                    continue;
                  }

                  const selector = registryEntry?.selector ?? localSelectors.get(depClassName);
                  const kind = registryEntry?.kind === 'pipe' ? 1 : 0; // 0=Directive, 1=Pipe

                  // Unresolved dependencies (e.g. library components like RouterOutlet)
                  // use a non-matching selector so they don't affect template instructions
                  // but still appear in the dependencies array for runtime resolution.
                  declarations.push({
                    type: dep,
                    selector: selector || `_unresolved-${depClassName}`,
                    kind,
                    ...(kind === 1 ? { name: registryEntry?.pipeName } : {})
                  });
                }

                // Resolve template content: inline template or read from templateUrl
                let templateContent = meta.template || '';
                if (!templateContent && meta.templateUrl) {
                  try {
                    const templatePath = path.resolve(path.dirname(fileName), meta.templateUrl);
                    templateContent = fs.readFileSync(templatePath, 'utf-8');
                  } catch {
                    console.warn(`[angular-compiler] Could not read template file "${meta.templateUrl}" for ${className}`);
                  }
                }

                // Resolve styles: read styleUrl/styleUrls files and inline their content
                if (Array.isArray(meta.styleUrls)) {
                  for (const url of meta.styleUrls) {
                    try {
                      const stylePath = path.resolve(path.dirname(fileName), url);
                      const styleContent = fs.readFileSync(stylePath, 'utf-8');
                      meta.styles.push(styleContent);
                    } catch {
                      console.warn(`[angular-compiler] Could not read style file "${url}" for ${className}`);
                    }
                  }
                }

                const parsedTemplate = parseTemplate(templateContent, fileName, { preserveWhitespaces: meta.preserveWhitespaces });

                // 1. Map Signal Inputs to Ivy Descriptors
                const ivyInputs: Record<string, any> = {};

                // Handle Decorator inputs (from @Component({ inputs: [...] }))
                if (Array.isArray(meta.inputs)) {
                  meta.inputs.forEach((i: string) => ivyInputs[i] = i);
                } else if (meta.inputs) {
                  Object.assign(ivyInputs, meta.inputs);
                }

                // Handle Signal/Model inputs
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
                  return '';
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
                  outputs: { ...meta.outputs, ...sigs.outputs },
                  viewQueries: sigs.viewQueries,
                  queries: sigs.contentQueries,
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
                    blocks: new Map(
                      collectDeferBlocks(parsedTemplate.nodes).map((n: any) => [n, null])
                    )
                  },
                  declarationListEmitMode: 0, // Direct
                  relativeContextFilePath: fileName,
                };

                // Angular 20+: hasDirectiveDependencies controls Full vs DomOnly template mode
                if (ANGULAR_MAJOR >= 20) {
                  componentMeta.hasDirectiveDependencies = declarations.length > 0;
                }


                const cmp = compileComponentFromMetadata(componentMeta, constantPool, bindingParser);
                ivyProps.push(createStaticProperty('ɵcmp', translateOutputAST(cmp.expression)));
                break;

              case 'Directive':
                targetType = FactoryTarget.Directive;
                const dir = compileDirectiveFromMetadata({
                  ...meta, name: className, type: classRef, typeSourceSpan, host: hostMetadata,
                  inputs: { ...meta.inputs, ...sigs.inputs },
                  outputs: { ...meta.outputs, ...sigs.outputs },
                  viewQueries: sigs.viewQueries,
                  queries: sigs.contentQueries,
                  providers: meta.providers, exportAs: meta.exportAs, isStandalone: meta.standalone,
                  lifecycle: { usesOnChanges: false },
                }, constantPool, bindingParser);
                ivyProps.push(createStaticProperty('ɵdir', translateOutputAST(dir.expression)));
                break;

              case 'Pipe':
                targetType = FactoryTarget.Pipe;
                const pipe = compilePipeFromMetadata({
                  ...meta, name: className, pipeName: meta.name, type: classRef,
                  isStandalone: meta.standalone, pure: meta.pure ?? true
                });
                ivyProps.push(createStaticProperty('ɵpipe', translateOutputAST(pipe.expression)));
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
                ivyProps.push(createStaticProperty('ɵprov', translateOutputAST(inj.expression)));
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
                ivyProps.push(createStaticProperty('ɵmod', translateOutputAST(ngMod.expression)));

                // Compile the injector (providers + imports)
                const injector = compileInjector({
                  name: className,
                  type: classRef,
                  providers: meta.providers ? new o.LiteralArrayExpr(meta.providers) : null,
                  imports: ngModuleImports.map((e: o.WrappedNodeExpr<any>) => e),
                });
                ivyProps.push(createStaticProperty('ɵinj', translateOutputAST(injector.expression)));
                break;
            }
          });

          const fac = compileFactoryFunction({
            name: className,
            type: classRef,
            typeArgumentCount: 0,
            deps: [],
            target: targetType,
          });
          ivyProps.unshift(createStaticProperty('ɵfac', translateOutputAST(fac.expression)));

          const angularDecSet = new Set(angularDecorators);
          return ts.factory.updateClassDeclaration(
            node,
            node.modifiers?.filter(m => !ts.isDecorator(m) || !angularDecSet.has(m)),
            node.name || ts.factory.createIdentifier(className),
            node.typeParameters,
            node.heritageClauses,
            [...node.members, ...ivyProps]
          );
        }
        return ts.visitEachChild(node, visitor, context);
      };
      return ts.visitNode(rootNode, visitor) as ts.SourceFile;
    };
  };

  const result = ts.transform(sourceFile, [transformer]);
  const printer = ts.createPrinter({ removeComments: true });
  const resourceCode = fileResourceImports.map(i => printer.printNode(ts.EmitHint.Unspecified, i, sourceFile)).join('\n');
  const mainCode = printer.printFile(result.transformed[0]);
  const constants = constantPool.statements.map(s => translateOutputASTStatement(s, printer, sourceFile)).join('\n');

  return `${resourceCode}\n${mainCode}\n\n${constants}`;
}

/** * EXHAUSTIVE EXPRESSION TRANSLATION
 */
function translateOutputAST(expr: o.Expression): ts.Expression {
  return expr.visitExpression(translator, null);
}

/** * EXHAUSTIVE STATEMENT TRANSLATION
 */
function translateOutputASTStatement(stmt: o.Statement, printer: ts.Printer, sf: ts.SourceFile): string {
  const tsNode = stmt.visitStatement(translator, null);

  // Printer expects a Node, visitStatement returns one.
  return printer.printNode(ts.EmitHint.Unspecified, tsNode as ts.Statement, sf);
}

/** * METADATA & RESOURCE HELPERS
 */
function extractMetadata(dec: ts.Decorator | undefined): any {
  if (!dec) return null;
  const call = dec.expression as ts.CallExpression;
  const obj = call.arguments[0] as ts.ObjectLiteralExpression;
  const meta: any = { hostRaw: {}, inputs: {}, outputs: {}, standalone: true, imports: [], providers: null, viewProviders: null, animations: null, changeDetection: 1, encapsulation: 0, preserveWhitespaces: false, exportAs: null, styles: [], templateUrl: null, styleUrls: [] };
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
      case 'imports': case 'providers': case 'viewProviders': case 'animations': case 'rawImports': case 'declarations': case 'exports': case 'bootstrap': if (ts.isArrayLiteralExpression(valNode)) meta[key] = valNode.elements.map(e => new o.WrappedNodeExpr(e)); break;
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
        inputs[name] = {
          classPropertyName: name,
          bindingPropertyName: name,
          isSignal: true,
          required: callExpr.includes('.required'),
          // v21 supports transform functions in the descriptor
          transform: callExpr.includes('transform') ? true : null 
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

function injectAngularImport(sf: ts.SourceFile) { return ts.factory.updateSourceFile(sf, [ts.factory.createImportDeclaration(undefined, ts.factory.createImportClause(false, undefined, ts.factory.createNamespaceImport(ts.factory.createIdentifier('i0'))), ts.factory.createStringLiteral('@angular/core')), ...sf.statements]); }
function createStaticProperty(n: string, i: ts.Expression) { return ts.factory.createPropertyDeclaration([ts.factory.createModifier(ts.SyntaxKind.StaticKeyword)], n, undefined, undefined, i); }