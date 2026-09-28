// A chunk assembled as one program from its pieces, for the chunk pass to compress and print: the modules
// as their finalized trees, the text the emitter writes around them (imports, runtime helpers, namespace
// objects, exports, addons) parsed.
//
// Positions: every piece is placed in one combined source, the pieces' own texts joined in chunk order,
// and its nodes and comments are moved there. A module piece's text is the module's source, so its
// positions map straight back to it; a text piece maps to nothing, as its text never came from a source.

import { N, type Node, node, set, UNSPANNED, walk } from '../../ast/index.ts';
import { COMMENT_STRIDE, classifyComment, commentAttachedTo, commentCount } from '../../parser/comments.ts';
import { parse } from '../../parser/index.ts';
import { type CommentPrintOptions, keepsComment, type SourceRegion } from '../../print/printer.ts';
import { buildLineTable } from '../../util/sourcemap.ts';
import type { ChunkProgram } from '../chunk-compress.ts';

export type ChunkPiece =
    | { kind: 'text'; code: string }
    | {
          kind: 'module';
          /** Finalized at position 0 of the module's source. */
          statements: Node[];
          source: string;
          comments: Int32Array;
          /** The comments the module's own render prints. */
          commentOptions: CommentPrintOptions;
          /** Whether the module's own render is minified, which decides how it prints `Infinity`. */
          minified: boolean;
          sourceIdx: number;
      };

/**
 * A literal the compressor built from a value (`-1`, `NaN`, `Infinity`), rebuilt in place as the shape
 * the parser gives its printed text: a sign is a unary minus, `NaN` and `Infinity` are globals, or
 * `1/0` where the module prints minified. The chunk pass sees what it would after a print and parse, as
 * rolldown's does.
 */
function asParsed(literal: Node, minified: boolean): void {
    const name = literal.name;
    if (literal.type === N.BigIntLiteral) {
        if (name[0] !== '-') return;
        const magnitude = node(N.BigIntLiteral, UNSPANNED, UNSPANNED, name.slice(1), null);
        set(literal, N.UnaryExpression, { operator: '-', prefix: true, argument: magnitude });
        return;
    }
    if (name[0] !== '-' && name !== 'NaN' && name !== 'Infinity') return;
    if (name[0] === '-') {
        const magnitude = node(N.NumericLiteral, UNSPANNED, UNSPANNED, name.slice(1), null);
        asParsed(magnitude, minified);
        set(literal, N.UnaryExpression, { operator: '-', prefix: true, argument: magnitude });
        return;
    }
    if (name === 'Infinity' && minified) {
        const one = node(N.NumericLiteral, UNSPANNED, UNSPANNED, '1', null);
        const zero = node(N.NumericLiteral, UNSPANNED, UNSPANNED, '0', null);
        set(literal, N.BinaryExpression, { operator: '/', left: one, right: zero });
        return;
    }
    set(literal, N.IdentifierReference, null);
}

/** Move every position in `statements` by `offset`, leaving unmapped ones alone, and give value-built
 *  literals their parsed shape. */
function placeStatements(statements: Node[], offset: number, minified: boolean): void {
    for (const statement of statements) {
        walk(statement, (inner) => {
            if (inner.type === N.NumericLiteral || inner.type === N.BigIntLiteral) asParsed(inner, minified);
            const moved = inner as { start: number; end: number };
            if (moved.start < 0) return;
            moved.start += offset;
            moved.end += offset;
        });
    }
}

export function assembleChunkProgram(pieces: ChunkPiece[], wantMap: boolean): ChunkProgram {
    const texts: string[] = [];
    const body: Node[] = [];
    const comments: number[] = [];
    const noSideEffectsAt: number[] = [];
    const sources: SourceRegion[] = [];
    /** Comments after the last statement of a piece, re-anchored to the next statement: in the chunk
     *  text they preceded it. Indexes into `comments`. */
    let trailing: number[] = [];
    let base = 0;
    const addComment = (records: Int32Array, index: number, end: number): void => {
        const record = index * COMMENT_STRIDE;
        const at = comments.length;
        for (let field = 0; field < COMMENT_STRIDE; field++) comments.push(records[record + field]);
        comments[at] += base;
        comments[at + 1] += base;
        if (commentAttachedTo(records, index) >= end) trailing.push(at);
        else comments[at + 3] += base;
    };
    const place = (statements: Node[]): void => {
        if (statements.length > 0 && trailing.length > 0) {
            for (const at of trailing) comments[at + 3] = statements[0].start;
            trailing = [];
        }
        for (const statement of statements) body.push(statement);
    };
    for (let index = 0; index < pieces.length; index++) {
        if (index > 0) {
            texts.push('\n');
            base += 1;
        }
        const piece = pieces[index];
        if (piece.kind === 'text') {
            const parsed = parse(piece.code, { ts: false, jsx: false, kind: 'module' });
            if (parsed.errors !== undefined && parsed.errors.length > 0)
                throw new Error(`chunk assembly: emitted text does not parse: ${parsed.errors[0]}`);
            const statements = (parsed.program.data as { body: Node[] }).body;
            placeStatements(statements, base, false);
            for (let comment = 0; comment < commentCount(parsed.comments); comment++)
                addComment(parsed.comments, comment, piece.code.length);
            for (const position of parsed.noSideEffectsAt) noSideEffectsAt.push(position + base);
            if (wantMap) sources.push({ start: base, lines: new Uint32Array([0]), sourceIdx: -1 });
            place(statements);
            texts.push(piece.code);
            base += piece.code.length;
            continue;
        }
        placeStatements(piece.statements, base, piece.minified);
        for (let comment = 0; comment < commentCount(piece.comments); comment++) {
            if (!keepsComment(piece.commentOptions, classifyComment(piece.source, piece.comments, comment))) continue;
            addComment(piece.comments, comment, piece.source.length);
        }
        if (wantMap)
            sources.push({ start: base, lines: Uint32Array.from(buildLineTable(piece.source)), sourceIdx: piece.sourceIdx });
        place(piece.statements);
        texts.push(piece.source);
        base += piece.source.length;
    }
    for (const at of trailing) comments[at + 3] = base;
    const program = node(N.Program, 0, base, '', { body, scopeId: 0 });
    return {
        program,
        src: texts.join(''),
        comments: Int32Array.from(comments),
        noSideEffectsAt,
        sources: wantMap ? sources : null,
    };
}
