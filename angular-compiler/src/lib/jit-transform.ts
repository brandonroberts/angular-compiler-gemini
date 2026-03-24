import * as ts from 'typescript';
import * as o from '@angular/compiler';
import {
  FactoryTarget,
  compileFactoryFunction,
} from '@angular/compiler';
import { AstTranslator } from './ast-translator';

const translator = new AstTranslator();

export interface JitTransformResult {
  code: string;
}

/**
 * JIT-only transform for Angular files.
 *
 * Unlike the full AOT compiler, this does NOT compile templates into Ivy
 * instructions. Instead it:
 *
 * 1. Preserves @Component/@Directive/@Pipe/@Injectable decorators for
 *    Angular's runtime JIT compiler to consume in the browser.
 * 2. Emits ɵfac (factory function) for dependency injection.
 * 3. Detects signal APIs (input, model, output, viewChild, etc.) and
 *    attaches signal metadata so the JIT compiler can read them.
 *
 * Template compilation happens at runtime in the browser.
 */
export function jitTransform(sourceCode: string, fileName: string): JitTransformResult {
  let sourceFile = ts.createSourceFile(fileName, sourceCode, ts.ScriptTarget.Latest, true);

  // Inject 'import * as i0 from "@angular/core"'
  sourceFile = ts.factory.updateSourceFile(sourceFile, [
    ts.factory.createImportDeclaration(
      undefined,
      ts.factory.createImportClause(false, undefined, ts.factory.createNamespaceImport(ts.factory.createIdentifier('i0'))),
      ts.factory.createStringLiteral('@angular/core')
    ),
    ...sourceFile.statements,
  ]);

  const ANGULAR_DECORATORS = ['Component', 'Directive', 'Pipe', 'Injectable', 'NgModule'];

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    return (rootNode) => {
      const visitor = (node: ts.Node): ts.Node => {
        if (!ts.isClassDeclaration(node)) {
          return ts.visitEachChild(node, visitor, context);
        }

        const className = node.name?.text || '_AnonymousClass';
        const decorators = ts.getDecorators(node);
        if (!decorators || decorators.length === 0) {
          return ts.visitEachChild(node, visitor, context);
        }

        const hasAngularDecorator = decorators.some(dec => {
          if (!ts.isCallExpression(dec.expression)) return false;
          return ANGULAR_DECORATORS.includes(dec.expression.expression.getText());
        });

        if (!hasAngularDecorator) {
          return ts.visitEachChild(node, visitor, context);
        }

        // Determine factory target from decorator
        let targetType = FactoryTarget.Injectable;
        for (const dec of decorators) {
          if (!ts.isCallExpression(dec.expression)) continue;
          const name = dec.expression.expression.getText();
          if (name === 'Component') targetType = FactoryTarget.Component;
          else if (name === 'Directive') targetType = FactoryTarget.Directive;
          else if (name === 'Pipe') targetType = FactoryTarget.Pipe;
          else if (name === 'NgModule') targetType = FactoryTarget.NgModule;
        }

        const classIdentifier = ts.factory.createIdentifier(className);
        const classRef: o.R3Reference = {
          value: new o.WrappedNodeExpr(classIdentifier),
          type: new o.WrappedNodeExpr(classIdentifier),
        };

        // Compile factory function for DI
        const fac = compileFactoryFunction({
          name: className,
          type: classRef,
          typeArgumentCount: 0,
          deps: [],
          target: targetType,
        });

        const facProp = ts.factory.createPropertyDeclaration(
          [ts.factory.createModifier(ts.SyntaxKind.StaticKeyword)],
          'ɵfac',
          undefined,
          undefined,
          fac.expression.visitExpression(translator, null)
        );

        // Build signal metadata properties
        const signalProps = buildSignalMetadata(node);

        // Keep decorators intact — JIT compiler reads them at runtime
        return ts.factory.updateClassDeclaration(
          node,
          node.modifiers,
          node.name || ts.factory.createIdentifier(className),
          node.typeParameters,
          node.heritageClauses,
          [...node.members, facProp, ...signalProps]
        );
      };
      return ts.visitNode(rootNode, visitor) as ts.SourceFile;
    };
  };

  const result = ts.transform(sourceFile, [transformer]);
  const printer = ts.createPrinter({ removeComments: false });
  const code = printer.printFile(result.transformed[0]);

  return { code };
}

/**
 * Build static signal metadata properties that Angular's JIT compiler
 * can read at runtime. Emits ɵinp (signal inputs) and ɵout (signal outputs)
 * as static properties on the class.
 */
function buildSignalMetadata(node: ts.ClassDeclaration): ts.ClassElement[] {
  const props: ts.ClassElement[] = [];
  const signalInputs: { name: string; required: boolean }[] = [];
  const signalOutputs: string[] = [];
  const signalModels: string[] = [];
  const signalQueries: { name: string; kind: string }[] = [];

  for (const member of node.members) {
    if (!ts.isPropertyDeclaration(member) || !member.initializer || !ts.isCallExpression(member.initializer)) {
      continue;
    }

    const name = member.name.getText();
    const callExpr = member.initializer.expression.getText();

    if (callExpr.includes('input')) {
      signalInputs.push({ name, required: callExpr.includes('.required') });
    } else if (callExpr.includes('model')) {
      signalModels.push(name);
    } else if (callExpr.includes('output')) {
      signalOutputs.push(name);
    } else if (callExpr.includes('viewChild') || callExpr.includes('viewChildren') ||
               callExpr.includes('contentChild') || callExpr.includes('contentChildren')) {
      const kind = callExpr.includes('view') ? 'view' : 'content';
      signalQueries.push({ name, kind });
    }
  }

  // Only emit metadata if there are signal APIs to describe
  if (signalInputs.length === 0 && signalOutputs.length === 0 &&
      signalModels.length === 0 && signalQueries.length === 0) {
    return props;
  }

  // Emit ɵsignals static property with all signal metadata
  // Angular's JIT compiler reads this to configure signal-based reactivity
  const entries: ts.ObjectLiteralElementLike[] = [];

  if (signalInputs.length > 0) {
    entries.push(ts.factory.createPropertyAssignment(
      'inputs',
      ts.factory.createObjectLiteralExpression(
        signalInputs.map(i => ts.factory.createPropertyAssignment(
          i.name,
          ts.factory.createObjectLiteralExpression([
            ts.factory.createPropertyAssignment('isSignal', ts.factory.createTrue()),
            ts.factory.createPropertyAssignment('required', i.required ? ts.factory.createTrue() : ts.factory.createFalse()),
          ])
        ))
      )
    ));
  }

  if (signalModels.length > 0) {
    entries.push(ts.factory.createPropertyAssignment(
      'models',
      ts.factory.createArrayLiteralExpression(
        signalModels.map(m => ts.factory.createStringLiteral(m))
      )
    ));
  }

  if (signalOutputs.length > 0) {
    entries.push(ts.factory.createPropertyAssignment(
      'outputs',
      ts.factory.createArrayLiteralExpression(
        signalOutputs.map(o => ts.factory.createStringLiteral(o))
      )
    ));
  }

  if (signalQueries.length > 0) {
    entries.push(ts.factory.createPropertyAssignment(
      'queries',
      ts.factory.createObjectLiteralExpression(
        signalQueries.map(q => ts.factory.createPropertyAssignment(
          q.name,
          ts.factory.createStringLiteral(q.kind)
        ))
      )
    ));
  }

  props.push(ts.factory.createPropertyDeclaration(
    [ts.factory.createModifier(ts.SyntaxKind.StaticKeyword)],
    'ɵsignals',
    undefined,
    undefined,
    ts.factory.createObjectLiteralExpression(entries, true)
  ));

  return props;
}
