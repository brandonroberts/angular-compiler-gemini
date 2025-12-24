import * as ts from 'typescript';
import * as o from '@angular/compiler';
import { 
  ConstantPool, 
  compileComponentFromMetadata, 
  compileDirectiveFromMetadata, 
  compilePipeFromMetadata, 
  FactoryTarget, 
  compileFactoryFunction, 
  parseTemplate, 
  makeBindingParser,
  parseHostBindings,
	JitEvaluator,
	EmitterVisitorContext
} from '@angular/compiler';

export function compile(sourceCode: string, fileName: string): string {
  let sourceFile = ts.createSourceFile(fileName, sourceCode, ts.ScriptTarget.Latest, true);
  const constantPool = new ConstantPool();
  const fileResourceImports: ts.ImportDeclaration[] = [];

  // Inject 'import * as i0 from "@angular/core"'
  sourceFile = injectAngularImport(sourceFile);

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    return (rootNode) => {
      const visitor = (node: ts.Node): ts.Node => {
        if (ts.isClassDeclaration(node) && node.name) {
          const className = node.name.text;
          const decorators = ts.getDecorators(node);
          if (!decorators || decorators.length === 0) return ts.visitEachChild(node, visitor, context);

          let ivyProps: ts.ClassElement[] = [];
          let targetType: FactoryTarget = FactoryTarget.Injectable;

          const classIdentifier = ts.factory.createIdentifier(className);
          const classRef: o.R3Reference = { 
            value: new o.WrappedNodeExpr(classIdentifier), 
            type: new o.WrappedNodeExpr(classIdentifier) 
          };

          const bindingParser = makeBindingParser();

          decorators.forEach(dec => {
            const decoratorName = (dec.expression as ts.CallExpression).expression.getText();
            const meta = extractMetadata(dec);
            const sigs = detectSignals(node);
            
            // Standardize host metadata using official parser + specialAttributes
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
                const res = processResources(meta, className);
                fileResourceImports.push(...res.imports);
                
                const cmp = compileComponentFromMetadata({
                  ...meta,
                  name: className,
                  type: classRef,
                  template: { 
                    nodes: parseTemplate(meta.template || '', fileName, { preserveWhitespaces: meta.preserveWhitespaces }).nodes, 
                    ngContentSelectors: [] 
                  },
                  styles: [
                    ...meta.styles.map((s: string) => new o.LiteralExpr(s)), 
                    ...res.styleSymbols.map(s => new o.ReadVarExpr(s))
                  ],
                  inputs: { ...meta.inputs, ...sigs.inputs },
                  outputs: { ...meta.outputs, ...sigs.outputs },
                  viewQueries: sigs.viewQueries,
                  queries: sigs.contentQueries,
                  host: hostMetadata,
                  changeDetection: meta.changeDetection,
                  encapsulation: meta.encapsulation,
                  exportAs: meta.exportAs,
                  providers: meta.providers,
                  viewProviders: meta.viewProviders,
                  animations: meta.animations,
                  isStandalone: meta.standalone,
                  imports: meta.imports,
									relativeContextFilePath: fileName
                }, constantPool, bindingParser);

                // If using external template, swap literal string for the Vite import variable
                const cmpExpr = cmp.expression;
                if (res.templateVar && cmpExpr instanceof o.LiteralMapExpr) {
                  const tplEntry = cmpExpr.entries.find(e => e.key === 'template');
                  if (tplEntry) tplEntry.value = new o.ReadVarExpr(res.templateVar);
                }
                
                ivyProps.push(createStaticProperty('ɵcmp', translateOutputAST(cmpExpr)));
                break;

              case 'Directive':
                targetType = FactoryTarget.Directive;
                const dir = compileDirectiveFromMetadata({
                  ...meta, name: className, type: classRef, host: hostMetadata,
                  inputs: { ...meta.inputs, ...sigs.inputs },
                  outputs: { ...meta.outputs, ...sigs.outputs },
                  queries: sigs.contentQueries,
                  providers: meta.providers, exportAs: meta.exportAs, isStandalone: meta.standalone
                }, constantPool, bindingParser);
                ivyProps.push(createStaticProperty('ɵdir', translateOutputAST(dir.expression)));
                break;

              case 'Pipe':
                targetType = FactoryTarget.Pipe;
                const pipe = compilePipeFromMetadata({
                  ...meta, name: className, pipeName: meta.name, type: classRef,
                  isStandalone: meta.standalone, pure: meta.pure !== false
                });
                ivyProps.push(createStaticProperty('ɵpipe', translateOutputAST(pipe.expression)));
                break;

              case 'Injectable':
                targetType = FactoryTarget.Injectable;
                const inj = o.compileInjectable({
                  name: className, type: classRef, internalType: classRef.value, typeArgumentCount: 0,
                  providedIn: { expression: new o.LiteralExpr(meta.providedIn || 'root') },
                }, true);
                ivyProps.push(createStaticProperty('ɵprov', translateOutputAST(inj.expression)));
                break;
            }
          });

          // Factory function (ɵfac) - No constructors used
          const fac = compileFactoryFunction({
            name: className, type: classRef, 
						// internalType: classRef.value,
            typeArgumentCount: 0,
						deps: [],
						target: targetType,
            // injectFn: o.importExpr({ name: 'ɵɵinject', moduleName: '@angular/core' })
          });
          ivyProps.unshift(createStaticProperty('ɵfac', translateOutputAST(fac.expression)));

          return ts.factory.updateClassDeclaration(
            node, node.modifiers?.filter(m => !ts.isDecorator(m)),
            node.name, node.typeParameters, node.heritageClauses,
            [...node.members, ...ivyProps]
          );
        }
        return ts.visitEachChild(node, visitor, context);
      };
      return ts.visitNode(rootNode, visitor) as ts.SourceFile;
    };
  };

  const result = ts.transform(sourceFile, [transformer]);
  const printer = ts.createPrinter();
  const resourceCode = fileResourceImports.map(i => printer.printNode(ts.EmitHint.Unspecified, i, sourceFile)).join('\n');
  const mainCode = printer.printFile(result.transformed[0]);
  const constants = constantPool.statements.map(s => translateOutputASTStatement(s, printer, sourceFile)).join('\n');

  return `${resourceCode}\n${mainCode}\n\n${constants}`;
}

/** * RESOURCE HANDLER (Vite compatibility)
 */
function processResources(meta: any, className: string) {
  const imports: ts.ImportDeclaration[] = [];
  const styleSymbols: string[] = [];
  let templateVar: string | null = null;

  if (meta.templateUrl) {
    templateVar = `${className}_Template`;
    imports.push(ts.factory.createImportDeclaration(undefined, ts.factory.createImportClause(false, ts.factory.createIdentifier(templateVar), undefined), ts.factory.createStringLiteral(`${meta.templateUrl}?raw`)));
  }

  if (Array.isArray(meta.styleUrls)) {
    meta.styleUrls.forEach((url, i) => {
      const sym = `${className}_Style_${i}`;
      styleSymbols.push(sym);
      imports.push(ts.factory.createImportDeclaration(undefined, ts.factory.createImportClause(false, ts.factory.createIdentifier(sym), undefined), ts.factory.createStringLiteral(url)));
    });
  }
  return { imports, styleSymbols, templateVar };
}

/** * EXHAUSTIVE METADATA EXTRACTION
 */
function extractMetadata(dec: ts.Decorator): any {
  const call = dec.expression as ts.CallExpression;
  const obj = call.arguments[0] as ts.ObjectLiteralExpression;
  const meta: any = { hostRaw: {}, inputs: {}, outputs: {}, standalone: true, imports: [], providers: null, viewProviders: null, animations: null, changeDetection: 1, encapsulation: 0, preserveWhitespaces: false, exportAs: null, styles: [], templateUrl: null, styleUrls: [], lifecycle: {}, defer: 0, declarations: [] };
  if (!obj) return meta;

  obj.properties.forEach(p => {
    if (!ts.isPropertyAssignment(p)) return;
    const key = p.name.getText().replace(/['"`]/g, '');
    const valNode = p.initializer;
    const valText = valNode.getText();

    switch(key) {
      case 'host':
        if (ts.isObjectLiteralExpression(valNode)) {
          valNode.properties.forEach(hp => {
            if (ts.isPropertyAssignment(hp)) meta.hostRaw[hp.name.getText().replace(/['"`]/g, '')] = hp.initializer.getText().replace(/['"`]/g, '');
          });
        }
        break;
      case 'changeDetection': meta.changeDetection = valText.includes('OnPush') ? 0 : 1; break;
      case 'encapsulation': meta.encapsulation = valText.includes('None') ? 2 : (valText.includes('ShadowDom') ? 3 : 0); break;
      case 'preserveWhitespaces': meta.preserveWhitespaces = valText === 'true'; break;
      case 'exportAs': meta.exportAs = [valText.replace(/['"`]/g, '')]; break;
      case 'templateUrl': meta.templateUrl = valText.replace(/['"`]/g, ''); break;
      case 'styleUrls': if (ts.isArrayLiteralExpression(valNode)) meta.styleUrls = valNode.elements.map(e => e.getText().replace(/['"`]/g, '')); break;
      case 'styles': if (ts.isArrayLiteralExpression(valNode)) meta.styles = valNode.elements.map(e => e.getText().replace(/['"`]/g, '')); break;
      case 'imports': case 'providers': case 'viewProviders': case 'animations':
        if (ts.isArrayLiteralExpression(valNode)) meta[key] = valNode.elements.map(e => new o.WrappedNodeExpr(e));
        break;
      default: meta[key] = valText.replace(/['"`]/g, '');
    }
  });
  return meta;
}

/** * AST EXPRESSION TRANSLATION
 */
function translateOutputAST(expr: o.Expression): ts.Expression {
  if (expr instanceof o.LiteralExpr) {
    if (typeof expr.value === 'string') return ts.factory.createStringLiteral(expr.value);
    if (typeof expr.value === 'number') return ts.factory.createNumericLiteral(String(expr.value));
    if (typeof expr.value === 'boolean') return expr.value ? ts.factory.createTrue() : ts.factory.createFalse();
    return ts.factory.createNull();
  }
  
  if (expr instanceof o.ExternalExpr) {
    return ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('i0'), ts.factory.createIdentifier(expr.value.name!));
  }

  if (expr instanceof o.ReadVarExpr) return ts.factory.createIdentifier(expr.name);
  if (expr instanceof o.ReadPropExpr) return ts.factory.createPropertyAccessExpression(translateOutputAST(expr.receiver), expr.name);

  if (expr instanceof o.FunctionExpr) {
    return ts.factory.createArrowFunction(
      undefined, undefined,
      expr.params.map(p => ts.factory.createParameterDeclaration(undefined, undefined, p.name, undefined, undefined, undefined)),
      undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      ts.factory.createBlock(expr.statements.map(s => translateOutputASTStatement(s, null as any, null as any) as ts.Statement), true)
    );
  }

  if (expr instanceof o.InvokeFunctionExpr) return ts.factory.createCallExpression(translateOutputAST(expr.fn), undefined, expr.args.map(translateOutputAST));
  // if (expr instanceof o.InvokeMethodExpr) return ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(translateOutputAST(expr.receiver), expr.name), undefined, expr.args.map(translateOutputAST));
  
  if (expr instanceof o.BinaryOperatorExpr) {
    const opMap: Record<o.BinaryOperator, ts.BinaryOperator> = {
      [o.BinaryOperator.And]: ts.SyntaxKind.AmpersandAmpersandToken, [o.BinaryOperator.Or]: ts.SyntaxKind.BarBarToken,
      [o.BinaryOperator.Equals]: ts.SyntaxKind.EqualsEqualsToken, [o.BinaryOperator.Identical]: ts.SyntaxKind.EqualsEqualsEqualsToken,
      [o.BinaryOperator.NotEquals]: ts.SyntaxKind.ExclamationEqualsToken, [o.BinaryOperator.NotIdentical]: ts.SyntaxKind.ExclamationEqualsEqualsToken,
      [o.BinaryOperator.Minus]: ts.SyntaxKind.MinusToken, [o.BinaryOperator.Plus]: ts.SyntaxKind.PlusToken,
      [o.BinaryOperator.Divide]: ts.SyntaxKind.SlashToken, [o.BinaryOperator.Multiply]: ts.SyntaxKind.AsteriskToken,
      [o.BinaryOperator.Modulo]: ts.SyntaxKind.PercentToken, [o.BinaryOperator.Lower]: ts.SyntaxKind.LessThanToken,
      [o.BinaryOperator.LowerEquals]: ts.SyntaxKind.LessThanEqualsToken, [o.BinaryOperator.Bigger]: ts.SyntaxKind.GreaterThanToken,
      [o.BinaryOperator.BiggerEquals]: ts.SyntaxKind.GreaterThanEqualsToken, [o.BinaryOperator.BitwiseAnd]: ts.SyntaxKind.AmpersandToken
    };
    return ts.factory.createBinaryExpression(translateOutputAST(expr.lhs), opMap[expr.operator] ?? ts.SyntaxKind.PlusToken, translateOutputAST(expr.rhs));
  }

  if (expr instanceof o.ConditionalExpr) return ts.factory.createConditionalExpression(translateOutputAST(expr.condition), ts.factory.createToken(ts.SyntaxKind.QuestionToken), translateOutputAST(expr.trueCase), ts.factory.createToken(ts.SyntaxKind.ColonToken), translateOutputAST(expr.falseCase!));
  if (expr instanceof o.NotExpr) return ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken, translateOutputAST(expr.condition));
  if (expr instanceof o.LiteralMapExpr) return ts.factory.createObjectLiteralExpression(expr.entries.map(e => ts.factory.createPropertyAssignment(ts.factory.createIdentifier(e.key), translateOutputAST(e.value))), true);
  if (expr instanceof o.LiteralArrayExpr) return ts.factory.createArrayLiteralExpression(expr.entries.map(translateOutputAST), true);
  if (expr instanceof o.WrappedNodeExpr) return expr.node as ts.Expression;

  return ts.factory.createNull();
}

/** * OTHER HELPERS (Signals & Boilerplate)
 */
function detectSignals(node: ts.ClassDeclaration) {
  const inputs: any = {}, outputs: any = {}, viewQueries: any[] = [], contentQueries: any[] = [];
  node.members.forEach(m => {
    if (ts.isPropertyDeclaration(m) && m.initializer && ts.isCallExpression(m.initializer)) {
      const name = m.name.getText(), callExpr = m.initializer.expression.getText();
      if (callExpr.includes('input')) inputs[name] = name;
      if (callExpr.includes('output')) outputs[name] = name;
      if (callExpr.includes('model')) { inputs[name] = name; outputs[name + 'Change'] = name + 'Change'; }
      if (callExpr.includes('Child') || callExpr.includes('Children')) {
        const query = { propertyName: name, predicate: ts.isStringLiteral(m.initializer.arguments[0]) ? [m.initializer.arguments[0].text] : new o.WrappedNodeExpr(m.initializer.arguments[0]), first: !callExpr.endsWith('ren'), descendants: true, read: null, static: false, emitFlags: 0 };
        if (callExpr.includes('view')) viewQueries.push(query); else contentQueries.push(query);
      }
    }
  });
  return { inputs, outputs, viewQueries, contentQueries };
}

function translateOutputASTStatement(stmt: o.Statement, printer: ts.Printer, sf: ts.SourceFile): string | ts.Statement {
  let tsStmt: ts.Statement;
  if (stmt instanceof o.DeclareVarStmt) tsStmt = ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList([ts.factory.createVariableDeclaration(stmt.name, undefined, undefined, stmt.value ? translateOutputAST(stmt.value) : undefined)], ts.NodeFlags.Const));
  else if (stmt instanceof o.ExpressionStatement) tsStmt = ts.factory.createExpressionStatement(translateOutputAST(stmt.expr));
  else tsStmt = ts.factory.createEmptyStatement();
  return printer ? printer.printNode(ts.EmitHint.Unspecified, tsStmt, sf) : tsStmt;
}

function injectAngularImport(sf: ts.SourceFile) { return ts.factory.updateSourceFile(sf, [ts.factory.createImportDeclaration(undefined, ts.factory.createImportClause(false, undefined, ts.factory.createNamespaceImport(ts.factory.createIdentifier('i0'))), ts.factory.createStringLiteral('@angular/core')), ...sf.statements]); }
function createStaticProperty(n: string, i: ts.Expression) { return ts.factory.createPropertyDeclaration([ts.factory.createModifier(ts.SyntaxKind.StaticKeyword)], n, undefined, undefined, i); }