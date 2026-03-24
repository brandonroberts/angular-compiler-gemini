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
export interface CompileResult {
  code: string;
  /** Absolute paths of external resources (templateUrl, styleUrl) read during compilation */
  resourceDependencies: string[];
}

export function compile(sourceCode: string, fileName: string, registry?: ComponentRegistry): CompileResult {
  let sourceFile = ts.createSourceFile(fileName, sourceCode, ts.ScriptTarget.Latest, true);
  const constantPool = new ConstantPool();
  const fileResourceImports: ts.ImportDeclaration[] = [];
  const resourceDependencies: string[] = [];
  const parseFile = new ParseSourceFile(sourceCode, fileName);
  const parseLoc = new ParseLocation(parseFile, 0, 0, 0);
  const typeSourceSpan = new ParseSourceSpan(parseLoc, parseLoc);
  const typeOnlyImports = collectTypeOnlyImports(sourceFile);

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
            const fields = detectFieldDecorators(node);
            const hostBindings = parseHostBindings(meta.hostRaw || {});

            // Merge host decorator bindings with host config object
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
                // Angular runtime requires a selector even for routed components
                if (!meta.selector) {
                  meta.selector = `ng-component-${className.toLowerCase()}`;
                }

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
                    resourceDependencies.push(templatePath);
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
                      resourceDependencies.push(stylePath);
                    } catch {
                      console.warn(`[angular-compiler] Could not read style file "${url}" for ${className}`);
                    }
                  }
                }

                const parsedTemplate = parseTemplate(templateContent, fileName, { preserveWhitespaces: meta.preserveWhitespaces });

                // Merge inputs: decorator config < @Input field decorators < signal inputs
                const ivyInputs: Record<string, any> = {};

                // Handle config inputs (from @Component({ inputs: [...] }))
                if (Array.isArray(meta.inputs)) {
                  meta.inputs.forEach((i: string) => ivyInputs[i] = i);
                } else if (meta.inputs) {
                  Object.assign(ivyInputs, meta.inputs);
                }

                // Handle @Input() field decorators
                Object.assign(ivyInputs, fields.inputs);

                // Handle Signal/Model inputs (take precedence)
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
                  inputs: { ...meta.inputs, ...fields.inputs, ...sigs.inputs },
                  outputs: { ...meta.outputs, ...fields.outputs, ...sigs.outputs },
                  viewQueries: [...fields.viewQueries, ...sigs.viewQueries],
                  queries: [...fields.contentQueries, ...sigs.contentQueries],
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

          const deps = extractConstructorDeps(node, typeOnlyImports);
          if (deps === null) {
            // Inherited factory: class extends Parent without own constructor
            // Emit: ɵfac = (() => { let base; return (t) => (base || (base = i0.ɵɵgetInheritedFactory(Class)))(t || Class); })()
            const baseVar = `ɵ${className}_BaseFactory`;
            const facCode = `/*@__PURE__*/ (() => { let ${baseVar}; return function ${className}_Factory(__ngFactoryType__) { return (${baseVar} || (${baseVar} = i0.ɵɵgetInheritedFactory(${className})))(__ngFactoryType__ || ${className}); }; })()`;
            ivyProps.unshift(ts.factory.createPropertyDeclaration(
              [ts.factory.createModifier(ts.SyntaxKind.StaticKeyword)],
              'ɵfac',
              undefined, undefined,
              ts.factory.createIdentifier(facCode) // Will be printed as-is
            ));
          } else if (deps === 'invalid') {
            // Invalid factory: type-only imports can't be injected
            const facCode = `function ${className}_Factory(__ngFactoryType__) { i0.ɵɵinvalidFactory(); }`;
            ivyProps.unshift(ts.factory.createPropertyDeclaration(
              [ts.factory.createModifier(ts.SyntaxKind.StaticKeyword)],
              'ɵfac',
              undefined, undefined,
              ts.factory.createIdentifier(facCode)
            ));
          } else {
            const fac = compileFactoryFunction({
              name: className,
              type: classRef,
              typeArgumentCount: 0,
              deps,
              target: targetType,
            });
            ivyProps.unshift(createStaticProperty('ɵfac', translateOutputAST(fac.expression)));
          }

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

  return {
    code: `${resourceCode}\n${mainCode}\n\n${constants}`,
    resourceDependencies,
  };
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