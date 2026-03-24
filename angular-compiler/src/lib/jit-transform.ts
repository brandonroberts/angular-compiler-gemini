import * as ts from 'typescript';

export interface JitTransformResult {
  code: string;
}

const ANGULAR_DECORATORS = new Set(['Component', 'Directive', 'Pipe', 'Injectable', 'NgModule']);

/**
 * JIT-only transform for Angular files.
 *
 * Converts TypeScript decorator syntax into static `decorators` arrays
 * that Angular's runtime JIT compiler reads via ReflectionCapabilities.
 * This survives esbuild/Vite's transform pipeline which strips TS decorators.
 *
 * Format: Class.decorators = [{ type: Component, args: [{ selector: '...', ... }] }];
 *
 * No template compilation, no Ivy instructions, no factory emission.
 * Angular's JIT compiler generates all metadata at runtime.
 */
export function jitTransform(sourceCode: string, fileName: string): JitTransformResult {
  let sourceFile = ts.createSourceFile(fileName, sourceCode, ts.ScriptTarget.Latest, true);

  const decoratorStatements: ts.Statement[] = [];

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    return (rootNode) => {
      const visitor = (node: ts.Node): ts.Node => {
        if (!ts.isClassDeclaration(node) || !node.name) {
          return ts.visitEachChild(node, visitor, context);
        }

        const decorators = ts.getDecorators(node);
        if (!decorators || decorators.length === 0) {
          return ts.visitEachChild(node, visitor, context);
        }

        const angularDecs = decorators.filter(dec => {
          if (!ts.isCallExpression(dec.expression)) return false;
          return ANGULAR_DECORATORS.has(dec.expression.expression.getText());
        });

        if (angularDecs.length === 0) {
          return ts.visitEachChild(node, visitor, context);
        }

        const className = node.name.text;

        // Build: Class.decorators = [{ type: DecoratorName, args: [{ ... }] }]
        const decoratorEntries = angularDecs.map(dec => {
          const call = dec.expression as ts.CallExpression;
          const decoratorName = call.expression;
          const args = call.arguments;

          const properties: ts.ObjectLiteralElementLike[] = [
            ts.factory.createPropertyAssignment('type', decoratorName as ts.Expression),
          ];

          if (args.length > 0) {
            properties.push(
              ts.factory.createPropertyAssignment(
                'args',
                ts.factory.createArrayLiteralExpression([...args])
              )
            );
          }

          return ts.factory.createObjectLiteralExpression(properties);
        });

        // Emit: ClassName.decorators = [{ type: ..., args: [...] }];
        decoratorStatements.push(
          ts.factory.createExpressionStatement(
            ts.factory.createBinaryExpression(
              ts.factory.createPropertyAccessExpression(
                ts.factory.createIdentifier(className),
                'decorators'
              ),
              ts.SyntaxKind.EqualsToken,
              ts.factory.createArrayLiteralExpression(decoratorEntries)
            )
          )
        );

        // Strip Angular decorators from the class, keep non-Angular ones
        const angularDecSet = new Set(angularDecs);
        return ts.factory.updateClassDeclaration(
          node,
          node.modifiers?.filter(m => !ts.isDecorator(m) || !angularDecSet.has(m)),
          node.name,
          node.typeParameters,
          node.heritageClauses,
          node.members
        );
      };

      return ts.visitNode(rootNode, visitor) as ts.SourceFile;
    };
  };

  const result = ts.transform(sourceFile, [transformer]);
  const transformed = result.transformed[0];

  // Append decorator statements after class declarations
  const finalFile = ts.factory.updateSourceFile(transformed, [
    ...transformed.statements,
    ...decoratorStatements,
  ]);

  const printer = ts.createPrinter({ removeComments: false });
  const code = printer.printFile(finalFile);

  return { code };
}
