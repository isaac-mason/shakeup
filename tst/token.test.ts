import { describe, expect, it } from 'vitest';
import {
    isAssignOp,
    isBinaryOp,
    isContextual,
    isKeyword,
    isLogical,
    isPunct,
    kindOf,
    opTextOf,
    precedenceOf,
    TK,
    TOK,
} from '../src/parser/token.ts';

// The spec the packed token must reproduce — transcribed from the parser's
// current BIN_PREC / BIN_OP / ASSIGN_OP / CONTEXTUAL tables. Stage 2c will make
// the parser consume token.ts; the meriyah differential is the end-to-end proof.
const BINARY: Record<string, [number, string, boolean]> = {
    QQ: [1, '??', true],
    PIPEPIPE: [2, '||', true],
    AMPAMP: [3, '&&', true],
    PIPE: [4, '|', false],
    CARET: [5, '^', false],
    AMP: [6, '&', false],
    EQEQ: [7, '==', false],
    NEQ: [7, '!=', false],
    EQEQEQ: [7, '===', false],
    NEQEQ: [7, '!==', false],
    LT: [8, '<', false],
    GT: [8, '>', false],
    LE: [8, '<=', false],
    GE: [8, '>=', false],
    IN: [8, 'in', false],
    INSTANCEOF: [8, 'instanceof', false],
    SHL: [9, '<<', false],
    SHR: [9, '>>', false],
    USHR: [9, '>>>', false],
    PLUS: [10, '+', false],
    MINUS: [10, '-', false],
    STAR: [11, '*', false],
    SLASH: [11, '/', false],
    PERCENT: [11, '%', false],
    STARSTAR: [12, '**', false],
};
const ASSIGN: Record<string, string> = {
    EQ: '=',
    PLUSEQ: '+=',
    MINUSEQ: '-=',
    STAREQ: '*=',
    SLASHEQ: '/=',
    PERCENTEQ: '%=',
    STARSTAREQ: '**=',
    SHLEQ: '<<=',
    SHREQ: '>>=',
    USHREQ: '>>>=',
    AMPEQ: '&=',
    PIPEEQ: '|=',
    CARETEQ: '^=',
    AMPAMPEQ: '&&=',
    PIPEPIPEEQ: '||=',
    QQEQ: '??=',
};
const CONTEXTUAL = new Set([
    'ASYNC', 'OF', 'AS', 'FROM', 'GET', 'SET', 'STATIC', 'TYPE', 'INTERFACE', 'NAMESPACE',
    'MODULE', 'DECLARE', 'ABSTRACT', 'OVERRIDE', 'READONLY', 'SATISFIES', 'KEYOF', 'INFER',
    'IS', 'ASSERTS', 'IMPLEMENTS', 'UNIQUE', 'ACCESSOR', 'YIELD', 'AWAIT', 'LET',
]);
const PUNCT = new Set([
    'LPAREN', 'RPAREN', 'LBRACE', 'RBRACE', 'LBRACKET', 'RBRACKET', 'SEMI', 'COMMA', 'DOT',
    'DOTDOTDOT', 'ARROW', 'COLON', 'QUESTION', 'QDOT', 'QQ', 'QQEQ', 'AT', 'EQ', 'EQEQ', 'EQEQEQ',
    'NEQ', 'NEQEQ', 'LT', 'GT', 'LE', 'GE', 'PLUS', 'MINUS', 'STAR', 'STARSTAR', 'SLASH', 'PERCENT',
    'PLUSPLUS', 'MINUSMINUS', 'SHL', 'SHR', 'USHR', 'AMP', 'PIPE', 'CARET', 'TILDE', 'BANG', 'AMPAMP',
    'PIPEPIPE', 'PLUSEQ', 'MINUSEQ', 'STAREQ', 'STARSTAREQ', 'SLASHEQ', 'PERCENTEQ', 'SHLEQ', 'SHREQ',
    'USHREQ', 'AMPEQ', 'PIPEEQ', 'CARETEQ', 'AMPAMPEQ', 'PIPEPIPEEQ',
]);
const names = Object.keys(TK) as (keyof typeof TK)[];

describe('token.ts packed metadata (bridge to the parser spec)', () => {
    it('binary operators carry the right precedence / text / logical flag', () => {
        for (const [name, [prec, text, logical]] of Object.entries(BINARY)) {
            const tok = TOK[name as keyof typeof TK];
            expect(isBinaryOp(tok), `${name} isBinaryOp`).toBe(true);
            expect(precedenceOf(tok), `${name} precedence`).toBe(prec);
            expect(opTextOf(tok), `${name} opText`).toBe(text);
            expect(isLogical(tok), `${name} isLogical`).toBe(logical);
        }
    });

    it('in / instanceof are ordinary precedence-8 binary ops (the unification)', () => {
        expect(isBinaryOp(TOK.IN) && precedenceOf(TOK.IN) === 8).toBe(true);
        expect(isBinaryOp(TOK.INSTANCEOF) && precedenceOf(TOK.INSTANCEOF) === 8).toBe(true);
        // and they are still keywords, not punctuators
        expect(isKeyword(TOK.IN) && isKeyword(TOK.INSTANCEOF)).toBe(true);
    });

    it('assignment operators carry the assign flag + text (and no precedence)', () => {
        for (const [name, text] of Object.entries(ASSIGN)) {
            const tok = TOK[name as keyof typeof TK];
            expect(isAssignOp(tok), `${name} isAssignOp`).toBe(true);
            expect(opTextOf(tok), `${name} opText`).toBe(text);
            expect(isBinaryOp(tok), `${name} not binary`).toBe(false);
        }
    });

    it('contextual keywords are flagged, reserved keywords are not', () => {
        for (const name of names) {
            if (!isKeyword(TOK[name])) continue;
            expect(isContextual(TOK[name]), `${name} contextual?`).toBe(CONTEXTUAL.has(name));
        }
    });

    it('punct / keyword flags partition correctly and are disjoint', () => {
        for (const name of names) {
            const tok = TOK[name];
            expect(isPunct(tok), `${name} isPunct`).toBe(PUNCT.has(name));
            expect(isPunct(tok) && isKeyword(tok), `${name} not both`).toBe(false);
        }
    });

    it('kindOf recovers the low-byte kind id', () => {
        for (const name of names) expect(kindOf(TOK[name])).toBe(TK[name]);
    });
});
