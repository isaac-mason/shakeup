// Port of oxc_minifier/src/keep_var.rs.

import { CHILD_FIELDS, create, type DataOf, isTypeOnlyNode, N, type Node, node, TYPE_NAME, VAR_KIND } from '../../ast/index.ts';
import { boundNames } from './bound-names.ts';

type KeptVar = { name: string; start: number; end: number; symbolId: number };

/** Collects the `var` names a dead statement declares, so their hoisted bindings can be kept. */
export type KeepVar = { vars: KeptVar[]; allHoisted: boolean };

export function createKeepVar(): KeepVar {
    return { vars: [], allHoisted: true };
}

/** Statements `KeepVar::visit_statement` descends into; any other statement is skipped whole. */
const HOISTING_STATEMENTS = new Set<number>([
    N.BlockStatement,
    N.BreakStatement,
    N.ContinueStatement,
    N.DoWhileStatement,
    N.ForInStatement,
    N.ForOfStatement,
    N.ForStatement,
    N.IfStatement,
    N.LabeledStatement,
    N.SwitchStatement,
    N.TryStatement,
    N.WhileStatement,
    N.WithStatement,
]);

/** Child fields that hold statements, so their children get `visit_statement` rather than a plain walk. */
function isStatementField(parentType: number, field: string): boolean {
    switch (parentType) {
        case N.Program:
        case N.BlockStatement:
        case N.StaticBlock:
        case N.ForStatement:
        case N.ForInStatement:
        case N.ForOfStatement:
        case N.WhileStatement:
        case N.DoWhileStatement:
        case N.LabeledStatement:
        case N.WithStatement:
            return field === 'body';
        case N.SwitchCase:
            return field === 'consequent';
        case N.IfStatement:
            return field === 'consequent' || field === 'alternate';
        default:
            return false;
    }
}

function visitVariableDeclaration(keepVar: KeepVar, declaration: Node): void {
    const data = declaration.data as DataOf<'VariableDeclaration'>;
    if (data.kind !== 'var') return;
    boundNames(declaration, (ident) => {
        keepVar.vars.push({ name: ident.name, start: ident.start, end: ident.end, symbolId: ident.sym });
    });
    if (data.declarations.some((declarator) => (declarator.data as DataOf<'VariableDeclarator'>).init !== null))
        keepVar.allHoisted = false;
}

function keepVarWalk(keepVar: KeepVar, root: Node, rootIsStatement: boolean): void {
    const pendingNodes: Node[] = [root];
    const pendingIsStatement: boolean[] = [rootIsStatement];
    while (pendingNodes.length > 0) {
        const current = pendingNodes.pop() as Node;
        const isStatement = pendingIsStatement.pop() as boolean;
        if (current.type === N.VariableDeclaration) {
            visitVariableDeclaration(keepVar, current);
            continue;
        }
        if (isStatement && !HOISTING_STATEMENTS.has(current.type)) continue;
        if (isTypeOnlyNode(current.type) || current.data === null) continue;
        const fields = CHILD_FIELDS[TYPE_NAME[current.type] as keyof typeof CHILD_FIELDS] as { name: string; list: boolean }[];
        const data = current.data as Record<string, unknown>;
        for (let fieldIndex = fields.length - 1; fieldIndex >= 0; fieldIndex--) {
            const field = fields[fieldIndex];
            const statementChild = isStatementField(current.type, field.name);
            const value = data[field.name];
            if (field.list) {
                const items = value as (Node | null)[];
                for (let index = items.length - 1; index >= 0; index--) {
                    const item = items[index];
                    if (item === null) continue;
                    pendingNodes.push(item);
                    pendingIsStatement.push(statementChild);
                }
            } else if (value != null) {
                pendingNodes.push(value as Node);
                pendingIsStatement.push(statementChild);
            }
        }
    }
}

/** oxc `KeepVar::visit_statement`. */
export const keepVarVisitStatement = (keepVar: KeepVar, statement: Node): void => keepVarWalk(keepVar, statement, true);

/** oxc `KeepVar::visit_block_statement`: a block reached directly, not in statement position. */
export const keepVarVisitBlockStatement = (keepVar: KeepVar, block: Node): void => keepVarWalk(keepVar, block, false);

/** A `var a, b;` with no initializers declaring every kept name, or null when there are none. */
export function keepVarVariableDeclaration(keepVar: KeepVar): Node | null {
    if (keepVar.vars.length === 0) return null;
    const declarators = keepVar.vars.map((kept) => {
        const id = node(N.BindingIdentifier, kept.start, kept.end, kept.name, null);
        id.sym = kept.symbolId;
        return create.VariableDeclarator(kept.start, kept.end, 0, id, null, null);
    });
    return create.VariableDeclaration(0, 0, VAR_KIND.VAR, declarators);
}

/** oxc `get_variable_declaration_statement`; a declaration is already a statement here. */
export const keepVarVariableDeclarationStatement = (keepVar: KeepVar): Node | null => keepVarVariableDeclaration(keepVar);
