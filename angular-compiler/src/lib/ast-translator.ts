import * as o from '@angular/compiler';
import * as ts from 'typescript';

export class AstTranslator implements o.ExpressionVisitor, o.StatementVisitor {
	visitTaggedTemplateLiteralExpr(ast: o.TaggedTemplateLiteralExpr, context: any) {
		const elements = ast.template.elements;
		const expressions = ast.template.expressions;

		if (expressions.length === 0) {
			// No substitutions - use NoSubstitutionTemplateLiteral
			return ts.factory.createTaggedTemplateExpression(
				ast.tag.visitExpression(this, null),
				undefined,
				ts.factory.createNoSubstitutionTemplateLiteral(elements[0].text, elements[0].text)
			);
		}

		// Has substitutions - use TemplateExpression
		const head = ts.factory.createTemplateHead(elements[0].text, elements[0].text);
		const spans = expressions.map((expr, i) => {
			const element = elements[i + 1];
			const literal = i === expressions.length - 1
				? ts.factory.createTemplateTail(element.text, element.text)
				: ts.factory.createTemplateMiddle(element.text, element.text);
			return ts.factory.createTemplateSpan(expr.visitExpression(this, null), literal);
		});

		return ts.factory.createTaggedTemplateExpression(
			ast.tag.visitExpression(this, null),
			undefined,
			ts.factory.createTemplateExpression(head, spans)
		);
	}

	visitTemplateLiteralExpr(ast: o.TemplateLiteralExpr, context: any) {
		// Standard ES6 template literal: `text ${expr} text`
		const headText = ast.elements[0].text;
		const head = ts.factory.createTemplateHead(headText, headText);

		const spans = ast.expressions.map((expr, i) => {
			const isLast = i === ast.expressions.length - 1;
			const content = ast.elements[i + 1].text;
			const literal = isLast
				? ts.factory.createTemplateTail(content, content)
				: ts.factory.createTemplateMiddle(content, content);

			return ts.factory.createTemplateSpan(expr.visitExpression(this, context), literal);
		});

		return ts.factory.createTemplateExpression(head, spans);
	}

	visitTemplateLiteralElementExpr(ast: o.TemplateLiteralElementExpr, context: any) {
		// Helper node for parts of a template literal
		return ts.factory.createStringLiteral(ast.text);
	}

	visitLocalizedString(ast: o.LocalizedString, context: any) {
		// Since we are ignoring i18n, we fall back to a simple template literal
		// This prevents the compiler from crashing if an i18n tag is accidentally used
		throw new Error('i18n is not supported');
	}

	visitDynamicImportExpr(ast: o.DynamicImportExpr, context: any) {
		// Handles lazy loading in @defer blocks: import('./chunk')
		return ts.factory.createCallExpression(
			ts.factory.createToken(ts.SyntaxKind.ImportKeyword) as any,
			undefined,
			[ast.url.visitExpression(this, context)]
		);
	}

	visitUnaryOperatorExpr(ast: o.UnaryOperatorExpr, context: any) {
		const operators = {
			[o.UnaryOperator.Minus]: ts.SyntaxKind.MinusToken,
			[o.UnaryOperator.Plus]: ts.SyntaxKind.PlusToken,
		};
		return ts.factory.createPrefixUnaryExpression(
			operators[ast.operator] || ts.SyntaxKind.PlusToken,
			ast.expr.visitExpression(this, context)
		);
	}

	visitCommaExpr(ast: o.CommaExpr, context: any) {
		// (a, b, c)
		return ast.parts
			.map(p => p.visitExpression(this, context))
			.reduce((prev, curr) => ts.factory.createBinaryExpression(prev, ts.SyntaxKind.CommaToken, curr));
	}

	visitVoidExpr(ast: o.VoidExpr, context: any) {
		// void 0
		return ts.factory.createVoidExpression(ast.expr.visitExpression(this, context));
	}

	visitArrowFunctionExpr(ast: o.ArrowFunctionExpr, context: any) {
		// Compact arrow functions used in signal effects or tracking logic
		return ts.factory.createArrowFunction(
			undefined,
			undefined,
			ast.params.map(p => ts.factory.createParameterDeclaration(undefined, undefined, p.name)),
			undefined,
			ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
			ast.body.visitExpression(this, context)
		);
	}

	visitParenthesizedExpr(ast: o.ParenthesizedExpr, context: any) {
		return ts.factory.createParenthesizedExpression(ast.expr.visitExpression(this, context));
	}

	visitRegularExpressionLiteral(ast: o.RegularExpressionLiteralExpr, context: any) {
		return ts.factory.createRegularExpressionLiteral(`/${ast.pattern}/${ast.flags}`);
	}

	// --- Expression Visitor (Exhaustive) ---

	visitReadVarExpr(ast: o.ReadVarExpr) { return ts.factory.createIdentifier(ast.name); }

	visitReadPropExpr(ast: o.ReadPropExpr) {
		return ts.factory.createPropertyAccessExpression(ast.receiver.visitExpression(this, null), ast.name);
	}

	visitReadKeyExpr(ast: o.ReadKeyExpr) {
		return ts.factory.createElementAccessExpression(ast.receiver.visitExpression(this, null), ast.index.visitExpression(this, null));
	}

visitLiteralExpr(ast: o.LiteralExpr) {
    if (typeof ast.value === 'string') return ts.factory.createStringLiteral(ast.value);
    
    if (typeof ast.value === 'number') {
      // TypeScript factory requires negative numbers to be a UnaryMinus + PositiveLiteral
      if (ast.value < 0) {
        return ts.factory.createPrefixUnaryExpression(
          ts.SyntaxKind.MinusToken,
          ts.factory.createNumericLiteral(Math.abs(ast.value).toString())
        );
      }
      return ts.factory.createNumericLiteral(ast.value.toString());
    }
    
    if (typeof ast.value === 'boolean') return ast.value ? ts.factory.createTrue() : ts.factory.createFalse();
    return ts.factory.createNull();
  }

	visitLiteralArrayExpr(ast: o.LiteralArrayExpr) {
		return ts.factory.createArrayLiteralExpression(ast.entries.map(e => e.visitExpression(this, null)), true);
	}

	visitLiteralMapExpr(ast: o.LiteralMapExpr) {
		return ts.factory.createObjectLiteralExpression(
			ast.entries.map(e => ts.factory.createPropertyAssignment(
				e.quoted ? ts.factory.createStringLiteral(e.key) : ts.factory.createIdentifier(e.key),
				e.value.visitExpression(this, null)
			)),
			true
		);
	}

	visitInvokeFunctionExpr(ast: o.InvokeFunctionExpr) {
		return ts.factory.createCallExpression(ast.fn.visitExpression(this, null), undefined, ast.args.map(a => a.visitExpression(this, null)));
	}

	visitInstantiateExpr(ast: o.InstantiateExpr) {
		return ts.factory.createNewExpression(ast.classExpr.visitExpression(this, null), undefined, ast.args.map(a => a.visitExpression(this, null)));
	}

	visitBinaryOperatorExpr(ast: o.BinaryOperatorExpr, context: any) {
		const opMap: Record<o.BinaryOperator, ts.BinaryOperator> = {
			[o.BinaryOperator.Equals]: ts.SyntaxKind.EqualsEqualsToken,
			[o.BinaryOperator.NotEquals]: ts.SyntaxKind.ExclamationEqualsToken,
			[o.BinaryOperator.Assign]: ts.SyntaxKind.EqualsToken,
			[o.BinaryOperator.Identical]: ts.SyntaxKind.EqualsEqualsEqualsToken,
			[o.BinaryOperator.NotIdentical]: ts.SyntaxKind.ExclamationEqualsEqualsToken,
			[o.BinaryOperator.Minus]: ts.SyntaxKind.MinusToken,
			[o.BinaryOperator.Plus]: ts.SyntaxKind.PlusToken,
			[o.BinaryOperator.Divide]: ts.SyntaxKind.SlashToken,
			[o.BinaryOperator.Multiply]: ts.SyntaxKind.AsteriskToken,
			[o.BinaryOperator.Modulo]: ts.SyntaxKind.PercentToken,
			[o.BinaryOperator.And]: ts.SyntaxKind.AmpersandAmpersandToken,
			[o.BinaryOperator.Or]: ts.SyntaxKind.BarBarToken,
			[o.BinaryOperator.BitwiseOr]: ts.SyntaxKind.BarToken,
			[o.BinaryOperator.BitwiseAnd]: ts.SyntaxKind.AmpersandToken,
			[o.BinaryOperator.Lower]: ts.SyntaxKind.LessThanToken,
			[o.BinaryOperator.LowerEquals]: ts.SyntaxKind.LessThanEqualsToken,
			[o.BinaryOperator.Bigger]: ts.SyntaxKind.GreaterThanToken,
			[o.BinaryOperator.BiggerEquals]: ts.SyntaxKind.GreaterThanEqualsToken,
			[o.BinaryOperator.NullishCoalesce]: ts.SyntaxKind.QuestionQuestionToken,
			[o.BinaryOperator.Exponentiation]: ts.SyntaxKind.AsteriskAsteriskToken,
			[o.BinaryOperator.In]: ts.SyntaxKind.InKeyword,
			[o.BinaryOperator.AdditionAssignment]: ts.SyntaxKind.PlusEqualsToken,
			[o.BinaryOperator.SubtractionAssignment]: ts.SyntaxKind.MinusEqualsToken,
			[o.BinaryOperator.MultiplicationAssignment]: ts.SyntaxKind.AsteriskEqualsToken,
			[o.BinaryOperator.DivisionAssignment]: ts.SyntaxKind.SlashEqualsToken,
			[o.BinaryOperator.RemainderAssignment]: ts.SyntaxKind.PercentEqualsToken,
			[o.BinaryOperator.ExponentiationAssignment]: ts.SyntaxKind.AsteriskAsteriskEqualsToken,
			[o.BinaryOperator.AndAssignment]: ts.SyntaxKind.AmpersandAmpersandEqualsToken,
			[o.BinaryOperator.OrAssignment]: ts.SyntaxKind.BarBarEqualsToken,
			[o.BinaryOperator.NullishCoalesceAssignment]: ts.SyntaxKind.QuestionQuestionEqualsToken,
		};

		const tsOperator = opMap[ast.operator];

		if (tsOperator === undefined) {
			throw new Error(`Unsupported binary operator: ${ast.operator}`);
		}

		return ts.factory.createBinaryExpression(
			ast.lhs.visitExpression(this, context),
			tsOperator,
			ast.rhs.visitExpression(this, context)
		);
	}

	visitConditionalExpr(ast: o.ConditionalExpr) {
		return ts.factory.createConditionalExpression(
			ast.condition.visitExpression(this, null),
			ts.factory.createToken(ts.SyntaxKind.QuestionToken),
			ast.trueCase.visitExpression(this, null),
			ts.factory.createToken(ts.SyntaxKind.ColonToken),
			ast.falseCase!.visitExpression(this, null)
		);
	}

	visitNotExpr(ast: o.NotExpr) {
		return ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken, ast.condition.visitExpression(this, null));
	}

	visitTypeofExpr(ast: o.TypeofExpr) {
		return ts.factory.createTypeOfExpression(ast.expr.visitExpression(this, null));
	}

	visitFunctionExpr(ast: o.FunctionExpr) {
		return ts.factory.createArrowFunction(
			undefined, undefined,
			ast.params.map(p => ts.factory.createParameterDeclaration(undefined, undefined, p.name)),
			undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
			ts.factory.createBlock(ast.statements.map(s => s.visitStatement(this, null)), true)
		);
	}

	visitWrappedNodeExpr(ast: o.WrappedNodeExpr<any>) { return ast.node as ts.Expression; }
	visitExternalExpr(ast: o.ExternalExpr) {
		return ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('i0'), ts.factory.createIdentifier(ast.value.name!));
	}

	// --- Statement Visitor (Exhaustive) ---

	visitDeclareVarStmt(stmt: o.DeclareVarStmt) {
		return ts.factory.createVariableStatement(
			undefined,
			ts.factory.createVariableDeclarationList([
				ts.factory.createVariableDeclaration(stmt.name, undefined, undefined, stmt.value ? stmt.value.visitExpression(this, null) : undefined)
			], stmt.hasModifier(o.StmtModifier.Final) ? ts.NodeFlags.Const : ts.NodeFlags.Let)
		);
	}

	visitDeclareFunctionStmt(stmt: o.DeclareFunctionStmt) {
		return ts.factory.createFunctionDeclaration(
			undefined, undefined, stmt.name, undefined,
			stmt.params.map(p => ts.factory.createParameterDeclaration(undefined, undefined, p.name)),
			undefined,
			ts.factory.createBlock(stmt.statements.map(s => s.visitStatement(this, null)), true)
		);
	}

	visitExpressionStmt(stmt: o.ExpressionStatement) {
		return ts.factory.createExpressionStatement(stmt.expr.visitExpression(this, null));
	}

	visitReturnStmt(stmt: o.ReturnStatement) {
		return ts.factory.createReturnStatement(stmt.value.visitExpression(this, null));
	}

	visitIfStmt(stmt: o.IfStmt) {
		return ts.factory.createIfStatement(
			stmt.condition.visitExpression(this, null),
			ts.factory.createBlock(stmt.trueCase.map(s => s.visitStatement(this, null)), true),
			stmt.falseCase.length ? ts.factory.createBlock(stmt.falseCase.map(s => s.visitStatement(this, null)), true) : undefined
		);
	}
}