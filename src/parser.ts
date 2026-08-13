// Fused lexer + parser producing the flat AST (src/ast.ts). The parser drives
// the lexer token-by-token: '/' is rescanned as regex only at expression
// starts, template continuations at the '}' of each interpolation, '>>' split
// inside type-argument lists. TS types parse into real nodes.
// Design notes: llm/notes/compilecat-requirements.md
// LIMIT: no JSX. Assignment-target destructuring stays as literal expression
// nodes (patterns are only parsed properly in binding positions).

import {
    type Ast,
    type NodeId,
    N,
    FL,
    OP,
    TSK,
    TSOP,
    VAR_KIND,
    addList,
    addNode,
    enumeration,
    make,
    resetAst,
} from './ast.ts';

/* ----------------------------------------------------------------- tokens */

const T_EOF = 0;
const T_IDENT = 1;
const T_KW = 2;
const T_NUM = 3;
const T_BIGINT = 4;
const T_STR = 5;
const T_TEMPLATE_FULL = 6;
const T_TEMPLATE_HEAD = 7;
const T_REGEX = 9;
const T_PUNCT = 10;
const T_PRIVATE = 11;

// punct codes (tokVal when tok === T_PUNCT; BIN_PREC/BIN_OP/ASSIGN_OP tables are
// sized 64 — punct count must stay below that)
const P = enumeration(
    'LPAREN', 'RPAREN', 'LBRACE', 'RBRACE', 'LBRACKET', 'RBRACKET',
    'SEMI', 'COMMA', 'DOT', 'DOTDOTDOT', 'ARROW', 'COLON', 'QUESTION',
    'QDOT', 'QQ', 'QQEQ', 'AT',
    'EQ', 'EQEQ', 'EQEQEQ', 'NEQ', 'NEQEQ', 'LT', 'GT', 'LE', 'GE',
    'PLUS', 'MINUS', 'STAR', 'STARSTAR', 'SLASH', 'PERCENT',
    'PLUSPLUS', 'MINUSMINUS', 'SHL', 'SHR', 'USHR',
    'AMP', 'PIPE', 'CARET', 'TILDE', 'BANG', 'AMPAMP', 'PIPEPIPE',
    'PLUSEQ', 'MINUSEQ', 'STAREQ', 'STARSTAREQ', 'SLASHEQ', 'PERCENTEQ',
    'SHLEQ', 'SHREQ', 'USHREQ', 'AMPEQ', 'PIPEEQ', 'CARETEQ',
    'AMPAMPEQ', 'PIPEPIPEEQ',
);

// keyword codes (tokVal when tok === T_KW)
const K = enumeration(
    'BREAK', 'CASE', 'CATCH', 'CLASS', 'CONST', 'CONTINUE', 'DEBUGGER',
    'DEFAULT', 'DELETE', 'DO', 'ELSE', 'EXPORT', 'EXTENDS', 'FINALLY',
    'FOR', 'FUNCTION', 'IF', 'IMPORT', 'IN', 'INSTANCEOF', 'LET',
    'NEW', 'RETURN', 'SUPER', 'SWITCH', 'THIS', 'THROW', 'TRY',
    'TYPEOF', 'VAR', 'VOID', 'WHILE', 'WITH', 'TRUE', 'FALSE',
    'NULL', 'YIELD', 'AWAIT', 'ASYNC', 'OF', 'AS', 'FROM', 'GET',
    'SET', 'STATIC', 'TYPE', 'INTERFACE', 'ENUM', 'NAMESPACE',
    'MODULE', 'DECLARE', 'ABSTRACT', 'OVERRIDE', 'READONLY',
    'SATISFIES', 'KEYOF', 'INFER', 'IS', 'ASSERTS', 'IMPLEMENTS',
    'UNIQUE', 'ACCESSOR',
);

// keywords usable as plain identifiers (contextual)
const CONTEXTUAL = new Set<number>([
    K.ASYNC, K.OF, K.AS, K.FROM, K.GET, K.SET, K.STATIC, K.TYPE, K.INTERFACE,
    K.NAMESPACE, K.MODULE, K.DECLARE, K.ABSTRACT, K.OVERRIDE, K.READONLY,
    K.SATISFIES, K.KEYOF, K.INFER, K.IS, K.ASSERTS, K.IMPLEMENTS, K.UNIQUE,
    K.ACCESSOR, K.YIELD, K.AWAIT, K.LET,
]);

const F_NL = 1; // tokFlags: newline before token

/* ------------------------------------------------------------ lexer state */

let src = '';
let srcLen = 0;
let pos = 0;
let tok = T_EOF;
let tokStart = 0;
let tokEnd = 0;
let tokFlags = 0;
let tokVal = 0;
let ast: Ast;
let tsMode = true;

// char class table
const C_WS = 1, C_NL = 2, C_ID = 3, C_DIG = 4;
const CHAR = new Uint8Array(128);
CHAR[9] = C_WS; CHAR[11] = C_WS; CHAR[12] = C_WS; CHAR[32] = C_WS;
CHAR[10] = C_NL; CHAR[13] = C_NL;
for (let i = 97; i <= 122; i++) CHAR[i] = C_ID;
for (let i = 65; i <= 90; i++) CHAR[i] = C_ID;
CHAR[95] = C_ID; CHAR[36] = C_ID;
for (let i = 48; i <= 57; i++) CHAR[i] = C_DIG;

function keywordCode(s: number, e: number): number {
    switch (e - s) {
        case 2:
            if (src.startsWith('if', s)) return K.IF;
            if (src.startsWith('in', s)) return K.IN;
            if (src.startsWith('do', s)) return K.DO;
            if (src.startsWith('of', s)) return K.OF;
            if (src.startsWith('as', s)) return K.AS;
            if (src.startsWith('is', s)) return K.IS;
            return 0;
        case 3:
            if (src.startsWith('var', s)) return K.VAR;
            if (src.startsWith('for', s)) return K.FOR;
            if (src.startsWith('new', s)) return K.NEW;
            if (src.startsWith('let', s)) return K.LET;
            if (src.startsWith('try', s)) return K.TRY;
            if (src.startsWith('get', s)) return K.GET;
            if (src.startsWith('set', s)) return K.SET;
            return 0;
        case 4:
            if (src.startsWith('this', s)) return K.THIS;
            if (src.startsWith('else', s)) return K.ELSE;
            if (src.startsWith('case', s)) return K.CASE;
            if (src.startsWith('true', s)) return K.TRUE;
            if (src.startsWith('null', s)) return K.NULL;
            if (src.startsWith('void', s)) return K.VOID;
            if (src.startsWith('with', s)) return K.WITH;
            if (src.startsWith('enum', s)) return K.ENUM;
            if (src.startsWith('from', s)) return K.FROM;
            if (src.startsWith('type', s)) return K.TYPE;
            return 0;
        case 5:
            if (src.startsWith('const', s)) return K.CONST;
            if (src.startsWith('class', s)) return K.CLASS;
            if (src.startsWith('super', s)) return K.SUPER;
            if (src.startsWith('while', s)) return K.WHILE;
            if (src.startsWith('break', s)) return K.BREAK;
            if (src.startsWith('catch', s)) return K.CATCH;
            if (src.startsWith('throw', s)) return K.THROW;
            if (src.startsWith('false', s)) return K.FALSE;
            if (src.startsWith('yield', s)) return K.YIELD;
            if (src.startsWith('async', s)) return K.ASYNC;
            if (src.startsWith('await', s)) return K.AWAIT;
            if (src.startsWith('keyof', s)) return K.KEYOF;
            if (src.startsWith('infer', s)) return K.INFER;
            return 0;
        case 6:
            if (src.startsWith('return', s)) return K.RETURN;
            if (src.startsWith('typeof', s)) return K.TYPEOF;
            if (src.startsWith('delete', s)) return K.DELETE;
            if (src.startsWith('import', s)) return K.IMPORT;
            if (src.startsWith('export', s)) return K.EXPORT;
            if (src.startsWith('switch', s)) return K.SWITCH;
            if (src.startsWith('static', s)) return K.STATIC;
            if (src.startsWith('module', s)) return K.MODULE;
            if (src.startsWith('unique', s)) return K.UNIQUE;
            return 0;
        case 7:
            if (src.startsWith('default', s)) return K.DEFAULT;
            if (src.startsWith('extends', s)) return K.EXTENDS;
            if (src.startsWith('finally', s)) return K.FINALLY;
            if (src.startsWith('declare', s)) return K.DECLARE;
            if (src.startsWith('asserts', s)) return K.ASSERTS;
            return 0;
        case 8:
            if (src.startsWith('function', s)) return K.FUNCTION;
            if (src.startsWith('continue', s)) return K.CONTINUE;
            if (src.startsWith('debugger', s)) return K.DEBUGGER;
            if (src.startsWith('abstract', s)) return K.ABSTRACT;
            if (src.startsWith('override', s)) return K.OVERRIDE;
            if (src.startsWith('readonly', s)) return K.READONLY;
            if (src.startsWith('accessor', s)) return K.ACCESSOR;
            return 0;
        case 9:
            if (src.startsWith('interface', s)) return K.INTERFACE;
            if (src.startsWith('namespace', s)) return K.NAMESPACE;
            if (src.startsWith('satisfies', s)) return K.SATISFIES;
            return 0;
        case 10:
            if (src.startsWith('instanceof', s)) return K.INSTANCEOF;
            if (src.startsWith('implements', s)) return K.IMPLEMENTS;
            return 0;
        default:
            return 0;
    }
}

function nextToken(): void {
    let nl = 0;
    while (pos < srcLen) {
        const c = src.charCodeAt(pos);
        if (c < 128) {
            const cls = CHAR[c];
            if (cls === C_WS) { pos++; continue; }
            if (cls === C_NL) { nl = F_NL; pos++; continue; }
            if (c === 47 /* / */) {
                const c1 = src.charCodeAt(pos + 1);
                if (c1 === 47) { // line comment
                    pos += 2;
                    while (pos < srcLen && src.charCodeAt(pos) !== 10) pos++;
                    continue;
                }
                if (c1 === 42) { // block comment
                    pos += 2;
                    while (pos < srcLen) {
                        const cc = src.charCodeAt(pos);
                        if (cc === 42 && src.charCodeAt(pos + 1) === 47) { pos += 2; break; }
                        if (cc === 10) nl = F_NL;
                        pos++;
                    }
                    continue;
                }
            }
            break;
        }
        if (c === 0x2028 || c === 0x2029) { nl = F_NL; pos++; continue; }
        if (c === 0xa0 || c === 0xfeff) { pos++; continue; }
        break;
    }
    tokFlags = nl;
    tokStart = pos;
    if (pos >= srcLen) { tok = T_EOF; tokEnd = pos; tokVal = 0; return; }
    const c = src.charCodeAt(pos);

    if (c < 128 ? CHAR[c] === C_ID : true) { // ident / keyword (non-ASCII = ident-ish)
        pos++;
        while (pos < srcLen) {
            const cc = src.charCodeAt(pos);
            if (cc < 128) { const cl = CHAR[cc]; if (cl !== C_ID && cl !== C_DIG) break; }
            else if (cc === 0x2028 || cc === 0x2029) break;
            pos++;
        }
        const kw = keywordCode(tokStart, pos);
        if (kw === 0) { tok = T_IDENT; tokVal = 0; } else { tok = T_KW; tokVal = kw; }
        tokEnd = pos;
        return;
    }
    if (CHAR[c] === C_DIG || (c === 46 && CHAR[src.charCodeAt(pos + 1)] === C_DIG)) {
        scanNumber();
        return;
    }
    if (c === 34 || c === 39) { // " '
        pos++;
        while (pos < srcLen) {
            const cc = src.charCodeAt(pos);
            if (cc === c) { pos++; break; }
            if (cc === 92) pos += 2;
            else pos++;
        }
        tok = T_STR; tokEnd = pos; tokVal = 0;
        return;
    }
    if (c === 96) { // `
        pos++;
        scanTemplatePart();
        return;
    }
    if (c === 35) { // #
        if (tokStart === 0 && src.charCodeAt(1) === 33) { // hashbang
            while (pos < srcLen && src.charCodeAt(pos) !== 10) pos++;
            nextToken();
            return;
        }
        pos++;
        while (pos < srcLen) {
            const cc = src.charCodeAt(pos);
            if (cc < 128 && CHAR[cc] !== C_ID && CHAR[cc] !== C_DIG) break;
            if (cc >= 128 && (cc === 0x2028 || cc === 0x2029)) break;
            pos++;
        }
        tok = T_PRIVATE; tokEnd = pos; tokVal = 0;
        return;
    }
    scanPunct(c);
}

function scanNumber(): void {
    let c = src.charCodeAt(pos);
    pos++;
    if (c === 48 && pos < srcLen) {
        const x = src.charCodeAt(pos) | 32;
        if (x === 120 || x === 111 || x === 98) pos++;
    }
    while (pos < srcLen) {
        c = src.charCodeAt(pos);
        if (c < 128 && (CHAR[c] === C_DIG || CHAR[c] === C_ID)) {
            if ((c | 32) === 101 && pos + 1 < srcLen) {
                const nx = src.charCodeAt(pos + 1);
                if (nx === 43 || nx === 45) pos++;
            }
            pos++;
        } else if (c === 46) pos++;
        else break;
    }
    tok = src.charCodeAt(pos - 1) === 110 ? T_BIGINT : T_NUM;
    tokEnd = pos;
    tokVal = 0;
}

/** scan template starting at pos (after ` or after the } of an interpolation) */
function scanTemplatePart(): void {
    // full or head depending on whether we hit ` or ${
    while (pos < srcLen) {
        const c = src.charCodeAt(pos);
        if (c === 96) { pos++; tok = T_TEMPLATE_FULL; tokEnd = pos; tokVal = 0; return; }
        if (c === 36 && src.charCodeAt(pos + 1) === 123) {
            pos += 2; tok = T_TEMPLATE_HEAD; tokEnd = pos; tokVal = 0; return;
        }
        if (c === 92) pos += 2;
        else pos++;
    }
    tok = T_TEMPLATE_FULL; tokEnd = pos; tokVal = 0; // unterminated
}

/** parser calls this when tok is RBRACE closing a template interpolation */
function reScanTemplateContinue(): void {
    pos = tokStart + 1; // skip the }
    tokStart = pos - 1;
    scanTemplatePart(); // T_TEMPLATE_FULL => tail, T_TEMPLATE_HEAD => middle
}

/** parser calls this at expression start when tok is SLASH / SLASHEQ */
function reScanRegex(): void {
    pos = tokStart + 1;
    let inClass = false;
    while (pos < srcLen) {
        const c = src.charCodeAt(pos);
        if (c === 92) { pos += 2; continue; }
        if (c === 91) inClass = true;
        else if (c === 93) inClass = false;
        else if (c === 47 && !inClass) {
            pos++;
            while (pos < srcLen) {
                const f = src.charCodeAt(pos);
                if (f < 128 && (CHAR[f] === C_ID || CHAR[f] === C_DIG)) pos++;
                else break;
            }
            tok = T_REGEX; tokEnd = pos; tokVal = 0;
            return;
        } else if (c === 10) break;
        pos++;
    }
    err('unterminated regex');
    tok = T_REGEX; tokEnd = pos; tokVal = 0;
}

function scanPunct(c: number): void {
    const c1 = pos + 1 < srcLen ? src.charCodeAt(pos + 1) : 0;
    const c2 = pos + 2 < srcLen ? src.charCodeAt(pos + 2) : 0;
    let v = 0;
    let n = 1;
    switch (c) {
        case 40: v = P.LPAREN; break;
        case 41: v = P.RPAREN; break;
        case 123: v = P.LBRACE; break;
        case 125: v = P.RBRACE; break;
        case 91: v = P.LBRACKET; break;
        case 93: v = P.RBRACKET; break;
        case 59: v = P.SEMI; break;
        case 44: v = P.COMMA; break;
        case 64: v = P.AT; break;
        case 126: v = P.TILDE; break;
        case 46:
            if (c1 === 46 && c2 === 46) { v = P.DOTDOTDOT; n = 3; } else v = P.DOT;
            break;
        case 61: // =
            if (c1 === 61) { if (c2 === 61) { v = P.EQEQEQ; n = 3; } else { v = P.EQEQ; n = 2; } }
            else if (c1 === 62) { v = P.ARROW; n = 2; }
            else v = P.EQ;
            break;
        case 33: // !
            if (c1 === 61) { if (c2 === 61) { v = P.NEQEQ; n = 3; } else { v = P.NEQ; n = 2; } }
            else v = P.BANG;
            break;
        case 60: // <
            if (c1 === 60) { if (c2 === 61) { v = P.SHLEQ; n = 3; } else { v = P.SHL; n = 2; } }
            else if (c1 === 61) { v = P.LE; n = 2; }
            else v = P.LT;
            break;
        case 62: // >
            if (c1 === 62) {
                if (c2 === 62) {
                    if (src.charCodeAt(pos + 3) === 61) { v = P.USHREQ; n = 4; } else { v = P.USHR; n = 3; }
                } else if (c2 === 61) { v = P.SHREQ; n = 3; }
                else { v = P.SHR; n = 2; }
            } else if (c1 === 61) { v = P.GE; n = 2; }
            else v = P.GT;
            break;
        case 43: // +
            if (c1 === 43) { v = P.PLUSPLUS; n = 2; } else if (c1 === 61) { v = P.PLUSEQ; n = 2; } else v = P.PLUS;
            break;
        case 45: // -
            if (c1 === 45) { v = P.MINUSMINUS; n = 2; } else if (c1 === 61) { v = P.MINUSEQ; n = 2; } else v = P.MINUS;
            break;
        case 42: // *
            if (c1 === 42) { if (c2 === 61) { v = P.STARSTAREQ; n = 3; } else { v = P.STARSTAR; n = 2; } }
            else if (c1 === 61) { v = P.STAREQ; n = 2; }
            else v = P.STAR;
            break;
        case 47: // /
            if (c1 === 61) { v = P.SLASHEQ; n = 2; } else v = P.SLASH;
            break;
        case 37: // %
            if (c1 === 61) { v = P.PERCENTEQ; n = 2; } else v = P.PERCENT;
            break;
        case 38: // &
            if (c1 === 38) { if (c2 === 61) { v = P.AMPAMPEQ; n = 3; } else { v = P.AMPAMP; n = 2; } }
            else if (c1 === 61) { v = P.AMPEQ; n = 2; }
            else v = P.AMP;
            break;
        case 124: // |
            if (c1 === 124) { if (c2 === 61) { v = P.PIPEPIPEEQ; n = 3; } else { v = P.PIPEPIPE; n = 2; } }
            else if (c1 === 61) { v = P.PIPEEQ; n = 2; }
            else v = P.PIPE;
            break;
        case 94: // ^
            if (c1 === 61) { v = P.CARETEQ; n = 2; } else v = P.CARET;
            break;
        case 63: // ?
            if (c1 === 63) { if (c2 === 61) { v = P.QQEQ; n = 3; } else { v = P.QQ; n = 2; } }
            else if (c1 === 46 && !(c2 >= 48 && c2 <= 57)) { v = P.QDOT; n = 2; }
            else v = P.QUESTION;
            break;
        case 58: v = P.COLON; break;
        default:
            err(`unexpected character '${String.fromCharCode(c)}'`);
            pos++;
            nextToken();
            return;
    }
    pos += n;
    tok = T_PUNCT; tokEnd = pos; tokVal = v;
}

/* ---------------------------------------------------------- parser helpers */



function err(msg: string): void {
    if (ast.errors.length < 100) ast.errors.push({ pos: tokStart, msg });
}

const isP = (v: number): boolean => tok === T_PUNCT && tokVal === v;
const isK = (v: number): boolean => tok === T_KW && tokVal === v;

function eatP(v: number): boolean {
    if (isP(v)) { nextToken(); return true; }
    return false;
}
function expectP(v: number, what: string): void {
    if (isP(v)) nextToken();
    else err(`expected ${what}`);
}
function eatK(v: number): boolean {
    if (isK(v)) { nextToken(); return true; }
    return false;
}

/** identifier including contextual keywords */
function isIdentLike(): boolean {
    return tok === T_IDENT || (tok === T_KW && CONTEXTUAL.has(tokVal));
}
/** any name valid after '.' or as a property key */
function isNameLike(): boolean {
    return tok === T_IDENT || tok === T_KW;
}

function parseIdent(): NodeId {
    if (!isIdentLike()) { err('expected identifier'); return makeMissingIdent(); }
    const id = addNode(ast, N.Ident, tokStart, tokEnd, 0, 0, 0);
    nextToken();
    return id;
}
function parseNameAsIdent(): NodeId {
    if (!isNameLike()) { err('expected name'); return makeMissingIdent(); }
    const id = addNode(ast, N.Ident, tokStart, tokEnd, 0, 0, 0);
    nextToken();
    return id;
}
function makeMissingIdent(): NodeId {
    return addNode(ast, N.Ident, tokStart, tokStart, 0, 0, 0);
}

const canInsertSemi = (): boolean => (tokFlags & F_NL) !== 0 || tok === T_EOF || isP(P.RBRACE);
function consumeSemi(): void {
    if (eatP(P.SEMI)) return;
    if (!canInsertSemi()) err("expected ';'");
}

type LexState = [number, number, number, number, number, number, number];
const saveState = (): LexState => [pos, tok, tokStart, tokEnd, tokFlags, tokVal, ast.errors.length];
function restoreState(s: LexState): void {
    pos = s[0]; tok = s[1]; tokStart = s[2]; tokEnd = s[3]; tokFlags = s[4]; tokVal = s[5];
    ast.errors.length = s[6];
}

// scratch stacks for list building (reused; grown on demand)
let stk = new Uint32Array(1 << 12);
let sp = 0;
function push(v: number): void {
    if (sp >= stk.length) { const n = new Uint32Array(stk.length * 2); n.set(stk); stk = n; }
    stk[sp++] = v;
}
function finishList(from: number): number {
    const ref = sp === from ? addList(ast, stk, 0, 0) : addList(ast, stk, from, sp);
    sp = from;
    return ref;
}

/* ------------------------------------------------------------ expressions */

// binary precedence: [prec, opcode] keyed by punct code
const BIN_PREC = new Uint8Array(64);
const BIN_OP = new Uint8Array(64);
{
    const set = (p: number, prec: number, op: number) => { BIN_PREC[p] = prec; BIN_OP[p] = op; };
    set(P.QQ, 1, OP.NULLISH);
    set(P.PIPEPIPE, 2, OP.OR);
    set(P.AMPAMP, 3, OP.AND);
    set(P.PIPE, 4, OP.BIT_OR);
    set(P.CARET, 5, OP.BIT_XOR);
    set(P.AMP, 6, OP.BIT_AND);
    set(P.EQEQ, 7, OP.EQ); set(P.NEQ, 7, OP.NE); set(P.EQEQEQ, 7, OP.SEQ); set(P.NEQEQ, 7, OP.SNE);
    set(P.LT, 8, OP.LT); set(P.GT, 8, OP.GT); set(P.LE, 8, OP.LE); set(P.GE, 8, OP.GE);
    set(P.SHL, 9, OP.SHL); set(P.SHR, 9, OP.SHR); set(P.USHR, 9, OP.USHR);
    set(P.PLUS, 10, OP.ADD); set(P.MINUS, 10, OP.SUB);
    set(P.STAR, 11, OP.MUL); set(P.SLASH, 11, OP.DIV); set(P.PERCENT, 11, OP.MOD);
    set(P.STARSTAR, 12, OP.EXP);
}
const ASSIGN_OP = new Uint8Array(64);
{
    const a = (p: number, op: number) => { ASSIGN_OP[p] = op; };
    a(P.EQ, OP.ASSIGN); a(P.PLUSEQ, OP.ADD_A); a(P.MINUSEQ, OP.SUB_A); a(P.STAREQ, OP.MUL_A);
    a(P.SLASHEQ, OP.DIV_A); a(P.PERCENTEQ, OP.MOD_A); a(P.STARSTAREQ, OP.EXP_A);
    a(P.SHLEQ, OP.SHL_A); a(P.SHREQ, OP.SHR_A); a(P.USHREQ, OP.USHR_A);
    a(P.AMPEQ, OP.AND_A); a(P.PIPEEQ, OP.OR_A); a(P.CARETEQ, OP.XOR_A);
    a(P.AMPAMPEQ, OP.LOGAND_A); a(P.PIPEPIPEEQ, OP.LOGOR_A); a(P.QQEQ, OP.NULLISH_A);
}

function parseExpression(noIn = false): NodeId {
    let expr = parseAssign(noIn);
    if (isP(P.COMMA)) {
        const start = ast.start[expr];
        const from = sp;
        push(expr);
        while (eatP(P.COMMA)) push(parseAssign(noIn));
        const list = finishList(from);
        return make.Seq(ast, start, tokStart, 0, list);
    }
    return expr;
}

function parseAssign(noIn = false): NodeId {
    // arrow lookaheads
    if (isP(P.LPAREN) && arrowAheadFromParen()) return parseArrow(tokStart, 0, 0);
    if (isIdentLike() && !isK(K.ASYNC)) {
        // Ident => body
        const s = saveState();
        if (tok === T_IDENT || CONTEXTUAL.has(tokVal)) {
            const idStart = tokStart;
            const maybe = parseIdent();
            if (isP(P.ARROW) && (tokFlags & F_NL) === 0) return parseArrowAfterSingleParam(idStart, maybe, 0);
            restoreState(s);
        }
    }
    if (isK(K.ASYNC) && (tokFlags & F_NL) === 0) {
        const s = saveState();
        const asyncStart = tokStart;
        nextToken();
        if ((tokFlags & F_NL) === 0) {
            if (isP(P.LPAREN) && arrowAheadFromParen()) return parseArrow(asyncStart, FL.ASYNC, 0);
            if (isIdentLike()) {
                const idStart = tokStart;
                const p = parseIdent();
                if (isP(P.ARROW)) return parseArrowAfterSingleParam(asyncStart, p, FL.ASYNC, idStart);
            }
        }
        restoreState(s);
    }
    if (tsMode && isP(P.LT)) {
        // <T>(args) => ...  generic arrow
        const s = saveState();
        const start = tokStart;
        const tp = tryParseTypeParams();
        if (tp !== -1 && isP(P.LPAREN) && arrowAheadFromParen()) return parseArrow(start, 0, tp);
        restoreState(s);
    }
    if (isK(K.YIELD)) {
        const start = tokStart;
        nextToken();
        let flags = 0;
        if (isP(P.STAR)) { flags |= FL.DELEGATE; nextToken(); }
        let arg = 0;
        if (!canInsertSemi() && !isP(P.RPAREN) && !isP(P.RBRACKET) && !isP(P.RBRACE) && !isP(P.COMMA) && !isP(P.SEMI) && !isP(P.COLON))
            arg = parseAssign(noIn);
        return make.Yield(ast, start, arg ? ast.end[arg] : tokStart, flags, arg);
    }

    const left = parseConditional(noIn);
    if (tok === T_PUNCT && ASSIGN_OP[tokVal] !== 0) {
        const op = ASSIGN_OP[tokVal];
        nextToken();
        const right = parseAssign(noIn);
        return make.Assign(ast, ast.start[left], ast.end[right], op, left, right);
    }
    return left;
}

function parseConditional(noIn: boolean): NodeId {
    const test = parseBinary(0, noIn);
    if (!isP(P.QUESTION)) return test;
    nextToken();
    const cons = parseAssign(false);
    expectP(P.COLON, "':'");
    const alt = parseAssign(noIn);
    return make.Cond(ast, ast.start[test], ast.end[alt], 0, test, cons, alt);
}

function parseBinary(minPrec: number, noIn: boolean): NodeId {
    let left = parseUnary();
    for (;;) {
        let prec = 0;
        let op = 0;
        let logical = false;
        if (tok === T_PUNCT) {
            prec = BIN_PREC[tokVal];
            op = BIN_OP[tokVal];
            logical = tokVal === P.QQ || tokVal === P.PIPEPIPE || tokVal === P.AMPAMP;
        } else if (tok === T_KW) {
            if (tokVal === K.IN && !noIn) { prec = 8; op = OP.IN; }
            else if (tokVal === K.INSTANCEOF) { prec = 8; op = OP.INSTANCEOF; }
            else if (tsMode && (tokVal === K.AS || tokVal === K.SATISFIES) && (tokFlags & F_NL) === 0) {
                const satisfies = tokVal === K.SATISFIES;
                nextToken();
                // `as const` — treat const as a TSTypeRef-shaped keyword use
                const ty = parseType();
                left = satisfies
                    ? make.TSSatisfies(ast, ast.start[left], ast.end[ty], 0, left, ty)
                    : make.TSAs(ast, ast.start[left], ast.end[ty], 0, left, ty);
                continue;
            }
        }
        if (prec === 0 || prec <= minPrec) return left;
        const rightAssoc = op === OP.EXP;
        nextToken();
        const right = parseBinary(rightAssoc ? prec - 1 : prec, noIn);
        left = logical
            ? make.Logical(ast, ast.start[left], ast.end[right], op, left, right)
            : make.Binary(ast, ast.start[left], ast.end[right], op, left, right);
    }
}

function parseUnary(): NodeId {
    const start = tokStart;
    if (tok === T_PUNCT) {
        switch (tokVal as number) {
            case P.PLUS: case P.MINUS: case P.BANG: case P.TILDE: {
                const op = tokVal === P.PLUS ? OP.POS : tokVal === P.MINUS ? OP.NEG : tokVal === P.BANG ? OP.NOT : OP.BIT_NOT;
                nextToken();
                const arg = parseUnary();
                return make.Unary(ast, start, ast.end[arg], op, arg);
            }
            case P.PLUSPLUS: case P.MINUSMINUS: {
                const op = tokVal === P.PLUSPLUS ? OP.INC : OP.DEC;
                nextToken();
                const arg = parseUnary();
                return make.Update(ast, start, ast.end[arg], op | FL.PREFIX, arg);
            }
            case P.LT:
                if (tsMode) break; // handled in parseAssign (generic arrow); '<' otherwise invalid prefix
                break;
        }
    } else if (tok === T_KW) {
        switch (tokVal as number) {
            case K.TYPEOF: case K.VOID: case K.DELETE: {
                const op = tokVal === K.TYPEOF ? OP.TYPEOF : tokVal === K.VOID ? OP.VOID : OP.DELETE;
                nextToken();
                const arg = parseUnary();
                return make.Unary(ast, start, ast.end[arg], op, arg);
            }
            case K.AWAIT: {
                nextToken();
                const arg = parseUnary();
                return make.Await(ast, start, ast.end[arg], 0, arg);
            }
        }
    }
    let expr = parsePostfixChain();
    if (tok === T_PUNCT && (tokVal === P.PLUSPLUS || tokVal === P.MINUSMINUS) && (tokFlags & F_NL) === 0) {
        const op = tokVal === P.PLUSPLUS ? OP.INC : OP.DEC;
        nextToken();
        expr = make.Update(ast, ast.start[expr], tokStart, op, expr);
    }
    return expr;
}

function parsePostfixChain(): NodeId {
    let expr: NodeId;
    if (isK(K.NEW)) expr = parseNew();
    else expr = parseMemberChain(parsePrimary(), true);
    return expr;
}

function parseNew(): NodeId {
    const start = tokStart;
    nextToken();
    if (isP(P.DOT)) { // new.target
        nextToken();
        parseNameAsIdent();
        return addNode(ast, N.MetaProp, start, tokStart, 2, 0, 0);
    }
    let callee: NodeId = isK(K.NEW) ? parseNew() : parseMemberChain(parsePrimary(), false);
    let typeArgs = 0;
    if (tsMode && isP(P.LT)) {
        const t = tryParseTypeArgsForCall();
        if (t !== -1) typeArgs = t;
    }
    let args = 0;
    let end = ast.end[callee];
    if (isP(P.LPAREN)) {
        args = parseArgs();
        end = tokStart;
    }
    const nw = make.New(ast, start, end, 0, callee, args, typeArgs);
    return parseMemberChain(nw, true);
}

function parseArgs(): number {
    nextToken();
    const from = sp;
    while (!isP(P.RPAREN) && (tok as number) !== T_EOF) {
        if (isP(P.DOTDOTDOT)) {
            const s = tokStart;
            nextToken();
            const arg = parseAssign();
            push(make.Spread(ast, s, ast.end[arg], 0, arg));
        } else push(parseAssign());
        if (!eatP(P.COMMA)) break;
    }
    expectP(P.RPAREN, "')'");
    return finishList(from);
}

function parseMemberChain(expr: NodeId, allowCall: boolean): NodeId {
    for (;;) {
        if (isP(P.DOT)) {
            nextToken();
            const prop = tok === T_PRIVATE ? parsePrivate() : parseNameAsIdent();
            expr = make.Member(ast, ast.start[expr], ast.end[prop], 0, expr, prop);
        } else if (isP(P.QDOT)) {
            nextToken();
            if (isP(P.LPAREN)) {
                if (!allowCall) return expr;
                const args = parseArgs();
                expr = make.Call(ast, ast.start[expr], tokStart, FL.OPTIONAL, expr, args, 0);
            } else if (isP(P.LBRACKET)) {
                nextToken();
                const prop = parseExpression();
                expectP(P.RBRACKET, "']'");
                expr = make.Member(ast, ast.start[expr], tokStart, FL.COMPUTED | FL.OPTIONAL, expr, prop);
            } else {
                const prop = tok === T_PRIVATE ? parsePrivate() : parseNameAsIdent();
                expr = make.Member(ast, ast.start[expr], ast.end[prop], FL.OPTIONAL, expr, prop);
            }
        } else if (isP(P.LBRACKET)) {
            nextToken();
            const prop = parseExpression();
            expectP(P.RBRACKET, "']'");
            expr = make.Member(ast, ast.start[expr], tokStart, FL.COMPUTED, expr, prop);
        } else if (allowCall && isP(P.LPAREN)) {
            const args = parseArgs();
            expr = make.Call(ast, ast.start[expr], tokStart, 0, expr, args, 0);
        } else if (tok === T_TEMPLATE_FULL || tok === T_TEMPLATE_HEAD) {
            const quasi = parseTemplate();
            expr = make.TaggedTemplate(ast, ast.start[expr], ast.end[quasi], 0, expr, quasi);
        } else if (tsMode && isP(P.BANG) && (tokFlags & F_NL) === 0) {
            nextToken();
            expr = make.TSNonNull(ast, ast.start[expr], tokStart, 0, expr);
        } else if (tsMode && allowCall && isP(P.LT)) {
            const t = tryParseTypeArgsForCall();
            if (t === -1) return expr;
            if (isP(P.LPAREN)) {
                const args = parseArgs();
                expr = make.Call(ast, ast.start[expr], tokStart, 0, expr, args, t);
            } else if (tok === T_TEMPLATE_FULL || tok === T_TEMPLATE_HEAD) {
                const quasi = parseTemplate();
                expr = make.TaggedTemplate(ast, ast.start[expr], ast.end[quasi], 0, expr, quasi);
            } else return expr; // type args not followed by call/template: instantiation expression
        } else return expr;
    }
}

function parsePrivate(): NodeId {
    const id = addNode(ast, N.PrivateIdent, tokStart, tokEnd, 0, 0, 0);
    nextToken();
    return id;
}

function parseTemplate(): NodeId {
    const start = tokStart;
    if (tok === T_TEMPLATE_FULL) {
        const q = addNode(ast, N.TemplateElement, start + 1, tokEnd - 1, 0, 0, 0);
        nextToken();
        const quasis = addList(ast, [q]);
        return make.TemplateLiteral(ast, start, ast.end[q] + 1, 0, quasis, 0);
    }
    // head
    const qFrom = sp;
    const eFrom: number[] = [];
    push(addNode(ast, N.TemplateElement, start + 1, tokEnd - 2, 0, 0, 0));
    nextToken();
    for (;;) {
        eFrom.push(parseExpression());
        if (!isP(P.RBRACE)) { err("expected '}' in template"); break; }
        reScanTemplateContinue();
        if (tok === T_TEMPLATE_FULL) { // tail: spans from }+1 to `-1
            push(addNode(ast, N.TemplateElement, tokStart + 1, tokEnd - 1, 0, 0, 0));
            nextToken();
            break;
        }
        push(addNode(ast, N.TemplateElement, tokStart + 1, tokEnd - 2, 0, 0, 0));
        nextToken();
    }
    const quasis = finishList(qFrom);
    const exprFrom = sp;
    for (const e of eFrom) push(e);
    const exprs = finishList(exprFrom);
    return make.TemplateLiteral(ast, start, tokStart, 0, quasis, exprs);
}

function parsePrimary(): NodeId {
    const start = tokStart;
    switch (tok) {
        case T_NUM: { const n = addNode(ast, N.Num, start, tokEnd, 0, 0, 0); nextToken(); return n; }
        case T_BIGINT: { const n = addNode(ast, N.BigInt, start, tokEnd, 0, 0, 0); nextToken(); return n; }
        case T_STR: { const n = addNode(ast, N.Str, start, tokEnd, 0, 0, 0); nextToken(); return n; }
        case T_REGEX: { const n = addNode(ast, N.Regex, start, tokEnd, 0, 0, 0); nextToken(); return n; }
        case T_TEMPLATE_FULL: case T_TEMPLATE_HEAD: return parseTemplate();
        case T_PRIVATE: return parsePrivate(); // `#x in obj`
        case T_IDENT: return parseIdent();
    }
    if (tok === T_PUNCT) {
        switch (tokVal as number) {
            case P.SLASH: case P.SLASHEQ:
                reScanRegex();
                return parsePrimary();
            case P.LPAREN: {
                nextToken();
                const e = parseExpression();
                expectP(P.RPAREN, "')'");
                return e; // parens not preserved (oxc preserve_parens:false model)
            }
            case P.LBRACKET: {
                nextToken();
                const from = sp;
                while (!isP(P.RBRACKET) && (tok as number) !== T_EOF) {
                    if (isP(P.COMMA)) { push(0); nextToken(); continue; } // hole
                    if (isP(P.DOTDOTDOT)) {
                        const s = tokStart;
                        nextToken();
                        const arg = parseAssign();
                        push(make.Spread(ast, s, ast.end[arg], 0, arg));
                    } else push(parseAssign());
                    if (!isP(P.RBRACKET)) expectP(P.COMMA, "','");
                }
                expectP(P.RBRACKET, "']'");
                return make.ArrayExpr(ast, start, tokStart, 0, finishList(from));
            }
            case P.LBRACE: return parseObjectLiteral();
        }
    } else if (tok === T_KW) {
        switch (tokVal as number) {
            case K.THIS: nextToken(); return addNode(ast, N.ThisExpr, start, tokStart, 0, 0, 0);
            case K.SUPER: nextToken(); return addNode(ast, N.SuperExpr, start, tokStart, 0, 0, 0);
            case K.TRUE: nextToken(); return addNode(ast, N.Bool, start, tokStart, 1, 0, 0);
            case K.FALSE: nextToken(); return addNode(ast, N.Bool, start, tokStart, 0, 0, 0);
            case K.NULL: nextToken(); return addNode(ast, N.Null, start, tokStart, 0, 0, 0);
            case K.FUNCTION: return parseFunction(false, false, true);
            case K.ASYNC:
                // async function expression (async arrows handled in parseAssign)
                nextToken();
                if (isK(K.FUNCTION)) return parseFunction(true, false, true);
                return addNode(ast, N.Ident, start, start + 5, 0, 0, 0);
            case K.CLASS: return parseClass(true, 0);
            case K.IMPORT: {
                nextToken();
                if (isP(P.DOT)) { // import.meta
                    nextToken();
                    parseNameAsIdent();
                    return addNode(ast, N.MetaProp, start, tokStart, 1, 0, 0);
                }
                expectP(P.LPAREN, "'('");
                const source = parseAssign();
                let options = 0;
                if (eatP(P.COMMA) && !isP(P.RPAREN)) options = parseAssign();
                eatP(P.COMMA);
                expectP(P.RPAREN, "')'");
                return make.ImportExpr(ast, start, tokStart, 0, source, options);
            }
            case K.NEW: return parseNew();
        }
        if (CONTEXTUAL.has(tokVal)) return parseIdent();
    }
    err('unexpected token in expression');
    nextToken();
    return makeMissingIdent();
}

function parseObjectLiteral(): NodeId {
    const start = tokStart;
    nextToken();
    const from = sp;
    let last = -1;
    while (!isP(P.RBRACE) && (tok as number) !== T_EOF) {
        if (tokStart === last) { err('unexpected token in object literal'); nextToken(); continue; }
        last = tokStart;
        if (isP(P.DOTDOTDOT)) {
            const s = tokStart;
            nextToken();
            const arg = parseAssign();
            push(make.Spread(ast, s, ast.end[arg], 0, arg));
        } else push(parseObjectMember());
        if (!isP(P.RBRACE)) expectP(P.COMMA, "','");
    }
    expectP(P.RBRACE, "'}'");
    return make.ObjectExpr(ast, start, tokStart, 0, finishList(from));
}

function parseObjectMember(): NodeId {
    const start = tokStart;
    let flags = 0;
    let async = false;
    let generator = false;
    // async/get/set/* are only prefixes if the next token isn't a property-name end (else they ARE the key)
    if (isK(K.ASYNC) && !nextIsPropertyEnd()) { async = true; nextToken(); }
    if (isP(P.STAR)) { generator = true; nextToken(); }
    let kind = 0;
    if ((isK(K.GET) || isK(K.SET)) && !nextIsPropertyEnd()) {
        kind = isK(K.GET) ? 1 : 2;
        nextToken();
    }
    let key: NodeId;
    if (isP(P.LBRACKET)) {
        flags |= FL.COMPUTED;
        nextToken();
        key = parseAssign();
        expectP(P.RBRACKET, "']'");
    } else if ((tok as number) === T_STR) { key = addNode(ast, N.Str, tokStart, tokEnd, 0, 0, 0); nextToken(); }
    else if (tok === T_NUM) { key = addNode(ast, N.Num, tokStart, tokEnd, 0, 0, 0); nextToken(); }
    else key = parseNameAsIdent();

    if (kind !== 0 || async || generator || isP(P.LPAREN)) {
        const fn = parseMethodTail(start, (async ? FL.ASYNC : 0) | (generator ? FL.GENERATOR : 0));
        flags |= kind << FL.KIND_SHIFT;
        return make.Property(ast, start, ast.end[fn], flags, key, fn);
    }
    if (isP(P.COLON)) {
        nextToken();
        const value = parseAssign();
        return make.Property(ast, start, ast.end[value], flags, key, value);
    }
    if (isP(P.EQ)) { // shorthand with default (in destructuring reinterpretation contexts)
        nextToken();
        const right = parseAssign();
        const value = make.AssignPattern(ast, ast.start[key], ast.end[right], 0, key, right);
        return make.Property(ast, start, ast.end[right], flags | FL.SHORTHAND, key, value);
    }
    return make.Property(ast, start, ast.end[key], flags | FL.SHORTHAND, key, key);
}

/** does the token after the current one end a property name position? ( : , } ( = ? etc.) */
function nextIsPropertyEnd(): boolean {
    const s = saveState();
    nextToken();
    const endLike =
        tok === T_EOF ||
        (tok === T_PUNCT &&
            (tokVal === P.COLON || tokVal === P.COMMA || tokVal === P.RBRACE || tokVal === P.LPAREN ||
                tokVal === P.EQ || tokVal === P.QUESTION || tokVal === P.SEMI || tokVal === P.RPAREN ||
                tokVal === P.LT || tokVal === P.BANG || tokVal === P.RBRACKET));
    restoreState(s);
    return endLike;
}

/** params + return type + body, packaged as FuncExpr (methods, accessors) */
function parseMethodTail(start: number, flags: number): NodeId {
    let typeParams = 0;
    if (tsMode && isP(P.LT)) { const t = tryParseTypeParams(); if (t !== -1) typeParams = t; }
    const params = parseParams();
    let returnType = 0;
    if (tsMode && isP(P.COLON)) returnType = parseTypeAnn();
    let body = 0;
    if (isP(P.LBRACE)) body = parseBlock();
    else consumeSemi(); // overload signature / declare
    return make.FuncExpr(ast, start, tokStart, flags, 0, typeParams, params, returnType, body);
}

/* --------------------------------------------------------------- arrows */

/** raw scan from '(' to decide arrow vs paren expr. Fast path; ambiguous ':' falls to speculative parse. */
function arrowAheadFromParen(): boolean {
    let p = tokStart + 1;
    let depth = 1;
    while (p < srcLen && depth > 0) {
        const c = src.charCodeAt(p);
        if (c === 40 || c === 91 || c === 123) depth += c === 40 ? 1 : 0, depth += c === 91 || c === 123 ? 1 : 0;
        else if (c === 41 || c === 93 || c === 125) depth--;
        else if (c === 34 || c === 39 || c === 96) {
            const q = c;
            p++;
            while (p < srcLen) {
                const cc = src.charCodeAt(p);
                if (cc === 92) { p += 2; continue; }
                if (cc === q) break;
                p++;
            }
        } else if (c === 47) {
            const c1 = src.charCodeAt(p + 1);
            if (c1 === 47) { while (p < srcLen && src.charCodeAt(p) !== 10) p++; continue; }
            if (c1 === 42) {
                p += 2;
                while (p < srcLen && !(src.charCodeAt(p) === 42 && src.charCodeAt(p + 1) === 47)) p++;
                p += 2;
                continue;
            }
        }
        p++;
    }
    for (;;) {
        while (p < srcLen) {
            const c = src.charCodeAt(p);
            if (c < 128 && (CHAR[c] === C_WS || CHAR[c] === C_NL)) p++;
            else break;
        }
        if (src.charCodeAt(p) === 47 && src.charCodeAt(p + 1) === 47) {
            while (p < srcLen && src.charCodeAt(p) !== 10) p++;
            continue;
        }
        if (src.charCodeAt(p) === 47 && src.charCodeAt(p + 1) === 42) {
            p += 2;
            while (p < srcLen && !(src.charCodeAt(p) === 42 && src.charCodeAt(p + 1) === 47)) p++;
            p += 2;
            continue;
        }
        break;
    }
    if (src.charCodeAt(p) === 61 && src.charCodeAt(p + 1) === 62) return true; // =>
    if (tsMode && src.charCodeAt(p) === 58) {
        // `): Type =>` — speculative: try full arrow parse, restore on failure
        const s = saveState();
        const ok = trySpeculativeArrow();
        restoreState(s);
        return ok;
    }
    return false;
}

function trySpeculativeArrow(): boolean {
    // current tok is '('
    try {
        speculating++;
        parseParams();
        if (isP(P.COLON)) parseTypeAnn();
        const ok = isP(P.ARROW);
        speculating--;
        return ok;
    } catch {
        speculating--;
        return false;
    }
}
let speculating = 0;

function parseArrow(start: number, flags: number, typeParams: number): NodeId {
    const params = parseParams();
    let returnType = 0;
    if (tsMode && isP(P.COLON)) returnType = parseTypeAnn();
    expectP(P.ARROW, "'=>'");
    let body: NodeId;
    if (isP(P.LBRACE)) body = parseBlock();
    else { body = parseAssign(); flags |= FL.EXPR_BODY; }
    return make.Arrow(ast, start, ast.end[body], flags, typeParams, params, returnType, body);
}

function parseArrowAfterSingleParam(start: number, ident: NodeId, flags: number, identStart?: number): NodeId {
    const param = make.Param(ast, identStart ?? start, ast.end[ident], 0, ident, 0, 0);
    const params = addList(ast, [param]);
    expectP(P.ARROW, "'=>'");
    let body: NodeId;
    if (isP(P.LBRACE)) body = parseBlock();
    else { body = parseAssign(); flags |= FL.EXPR_BODY; }
    return make.Arrow(ast, start, ast.end[body], flags, 0, params, 0, body);
}

/* ------------------------------------------------------- binding patterns */

function parseBindingTarget(): NodeId {
    if (isP(P.LBRACKET)) {
        const start = tokStart;
        nextToken();
        const from = sp;
        while (!isP(P.RBRACKET) && (tok as number) !== T_EOF) {
            if (isP(P.COMMA)) { push(0); nextToken(); continue; }
            if (isP(P.DOTDOTDOT)) {
                const s = tokStart;
                nextToken();
                const arg = parseBindingTarget();
                push(make.RestElement(ast, s, ast.end[arg], 0, arg, 0));
            } else push(parseBindingElement());
            if (!isP(P.RBRACKET)) expectP(P.COMMA, "','");
        }
        expectP(P.RBRACKET, "']'");
        return make.ArrayPattern(ast, start, tokStart, 0, finishList(from));
    }
    if (isP(P.LBRACE)) {
        const start = tokStart;
        nextToken();
        const from = sp;
        while (!isP(P.RBRACE) && (tok as number) !== T_EOF) {
            if (isP(P.DOTDOTDOT)) {
                const s = tokStart;
                nextToken();
                const arg = parseBindingTarget();
                push(make.RestElement(ast, s, ast.end[arg], 0, arg, 0));
            } else {
                const s = tokStart;
                let flags = 0;
                let key: NodeId;
                if (isP(P.LBRACKET)) {
                    flags |= FL.COMPUTED;
                    nextToken();
                    key = parseAssign();
                    expectP(P.RBRACKET, "']'");
                } else if ((tok as number) === T_STR) { key = addNode(ast, N.Str, tokStart, tokEnd, 0, 0, 0); nextToken(); }
                else if (tok === T_NUM) { key = addNode(ast, N.Num, tokStart, tokEnd, 0, 0, 0); nextToken(); }
                else key = parseNameAsIdent();
                let value: NodeId;
                if (isP(P.COLON)) { nextToken(); value = parseBindingElement(); }
                else if (isP(P.EQ)) {
                    nextToken();
                    const right = parseAssign();
                    value = make.AssignPattern(ast, ast.start[key], ast.end[right], 0, key, right);
                    flags |= FL.SHORTHAND;
                } else { value = key; flags |= FL.SHORTHAND; }
                push(make.Property(ast, s, ast.end[value], flags, key, value));
            }
            if (!isP(P.RBRACE)) expectP(P.COMMA, "','");
        }
        expectP(P.RBRACE, "'}'");
        return make.ObjectPattern(ast, start, tokStart, 0, finishList(from));
    }
    return parseIdent();
}

function parseBindingElement(): NodeId {
    const target = parseBindingTarget();
    if (isP(P.EQ)) {
        nextToken();
        const right = parseAssign();
        return make.AssignPattern(ast, ast.start[target], ast.end[right], 0, target, right);
    }
    return target;
}

function parseParams(): number {
    expectP(P.LPAREN, "'('");
    const from = sp;
    while (!isP(P.RPAREN) && (tok as number) !== T_EOF) {
        const start = tokStart;
        let flags = 0;
        if (tsMode) {
            // ctor param props: accessibility / readonly prefixes
            for (;;) {
                if ((isK(K.READONLY) || isK(K.OVERRIDE)) && !nextIsParamNameEnd()) { flags |= FL.READONLY; nextToken(); }
                else if (isK(K.STATIC) && !nextIsParamNameEnd()) nextToken();
                else if (tok === T_KW && (tokVal === K.IMPLEMENTS || tokVal === K.INTERFACE) && !nextIsParamNameEnd()) nextToken();
                else if (tok === T_IDENT && (src.startsWith('public', tokStart) || src.startsWith('private', tokStart) || src.startsWith('protected', tokStart)) && tokEnd - tokStart <= 9 && !nextIsParamNameEnd()) {
                    const access = src.startsWith('public', tokStart) ? 1 : src.startsWith('private', tokStart) ? 2 : 3;
                    flags |= access << FL.ACCESS_SHIFT;
                    nextToken();
                } else break;
            }
        }
        if (isP(P.DOTDOTDOT)) {
            nextToken();
            const arg = parseBindingTarget();
            let typeAnn = 0;
            if (tsMode && isP(P.COLON)) typeAnn = parseTypeAnn();
            push(make.RestElement(ast, start, tokStart, 0, arg, typeAnn));
        } else if (isK(K.THIS) && tsMode) {
            // `this: Foo` fake param — parse and drop into a normal Param
            const t = addNode(ast, N.Ident, tokStart, tokEnd, 0, 0, 0);
            nextToken();
            let typeAnn = 0;
            if (isP(P.COLON)) typeAnn = parseTypeAnn();
            push(make.Param(ast, start, tokStart, 0, t, typeAnn, 0));
        } else {
            const pattern = parseBindingTarget();
            if (tsMode && isP(P.QUESTION)) { flags |= FL.OPTIONAL; nextToken(); }
            let typeAnn = 0;
            if (tsMode && isP(P.COLON)) typeAnn = parseTypeAnn();
            let init = 0;
            if (isP(P.EQ)) { nextToken(); init = parseAssign(); }
            push(make.Param(ast, start, tokStart, flags, pattern, typeAnn, init));
        }
        if (!eatP(P.COMMA)) break;
    }
    expectP(P.RPAREN, "')'");
    return finishList(from);
}

function nextIsParamNameEnd(): boolean {
    const s = saveState();
    nextToken();
    const end =
        tok === T_EOF ||
        (tok === T_PUNCT &&
            (tokVal === P.COLON || tokVal === P.COMMA || tokVal === P.RPAREN || tokVal === P.QUESTION || tokVal === P.EQ));
    restoreState(s);
    return end;
}

/* -------------------------------------------------------------- functions */

function parseFunction(async: boolean, isDecl: boolean, isExpr: boolean): NodeId {
    const start = tokStart;
    nextToken();
    let flags = async ? FL.ASYNC : 0;
    if (isP(P.STAR)) { flags |= FL.GENERATOR; nextToken(); }
    let id = 0;
    if (isIdentLike()) id = parseIdent();
    let typeParams = 0;
    if (tsMode && isP(P.LT)) { const t = tryParseTypeParams(); if (t !== -1) typeParams = t; }
    const params = parseParams();
    let returnType = 0;
    if (tsMode && isP(P.COLON)) returnType = parseTypeAnn();
    let body = 0;
    if (isP(P.LBRACE)) body = parseBlock();
    else consumeSemi(); // overload / declare
    const type = isDecl && !isExpr ? N.FuncDecl : N.FuncExpr;
    return make[type === N.FuncDecl ? 'FuncDecl' : 'FuncExpr'](ast, start, tokStart, flags, id, typeParams, params, returnType, body);
}

function parseClass(isExpr: boolean, extraFlags: number, startOverride = -1): NodeId {
    const start = startOverride >= 0 ? startOverride : tokStart; // include `abstract` when present
    nextToken();
    let id = 0;
    if (isIdentLike() && !isK(K.EXTENDS) && !isK(K.IMPLEMENTS)) id = parseIdent();
    let typeParams = 0;
    if (tsMode && isP(P.LT)) { const t = tryParseTypeParams(); if (t !== -1) typeParams = t; }
    let superClass = 0;
    let superTypeArgs = 0;
    if (eatK(K.EXTENDS)) {
        superClass = parseMemberChain(parsePrimary(), true);
        if (tsMode && isP(P.LT)) { const t = tryParseTypeArgsInType(); if (t !== -1) superTypeArgs = t; }
    }
    const implFrom = sp;
    if (tsMode && eatK(K.IMPLEMENTS)) {
        do {
            const s = tokStart;
            let expr = parseIdent();
            while (isP(P.DOT)) { nextToken(); const r = parseNameAsIdent(); expr = make.TSQualifiedName(ast, s, ast.end[r], 0, expr, r); }
            let targs = 0;
            if (isP(P.LT)) { const t = tryParseTypeArgsInType(); if (t !== -1) targs = t; }
            push(make.TSHeritage(ast, s, tokStart, 0, expr, targs));
        } while (eatP(P.COMMA));
    }
    const impls = finishList(implFrom);
    const body = parseClassBody();
    const mk = isExpr ? make.ClassExpr : make.ClassDecl;
    return mk(ast, start, tokStart, extraFlags, id, typeParams, superClass, superTypeArgs, impls, body);
}

function parseClassBody(): number {
    expectP(P.LBRACE, "'{'");
    const from = sp;
    let last = -1;
    while (!isP(P.RBRACE) && (tok as number) !== T_EOF) {
        if (eatP(P.SEMI)) continue;
        if (tokStart === last) { err('unexpected token in class body'); nextToken(); continue; }
        last = tokStart;
        push(parseClassMember());
    }
    expectP(P.RBRACE, "'}'");
    return finishList(from);
}

function parseClassMember(): NodeId {
    const start = tokStart;
    let flags = 0;
    let async = false;
    let generator = false;
    for (;;) {
        if (isK(K.STATIC) && !nextIsPropertyEnd()) {
            // `static {` is a static block, not a static member named `static`
            const s = saveState();
            nextToken();
            if (isP(P.LBRACE)) {
                const b = parseBlock();
                // repackage as StaticBlock (reuse block's list ref)
                return make.StaticBlock(ast, start, tokStart, 0, ast.a[b]);
            }
            restoreState(s);
            flags |= FL.STATIC;
            nextToken();
        } else if (tok === T_IDENT && !nextIsPropertyEnd() && isAccessModifier()) {
            const access = src.startsWith('public', tokStart) ? 1 : src.startsWith('private', tokStart) ? 2 : 3;
            flags |= access << FL.ACCESS_SHIFT;
            nextToken();
        } else if (isK(K.READONLY) && !nextIsPropertyEnd()) { flags |= FL.READONLY; nextToken(); }
        else if (isK(K.ABSTRACT) && !nextIsPropertyEnd()) { flags |= FL.ABSTRACT; nextToken(); }
        else if (isK(K.DECLARE) && !nextIsPropertyEnd()) { flags |= FL.DECLARE; nextToken(); }
        else if (isK(K.OVERRIDE) && !nextIsPropertyEnd()) nextToken();
        else if (isK(K.ACCESSOR) && !nextIsPropertyEnd()) nextToken();
        else break;
    }
    if (isK(K.ASYNC) && !nextIsPropertyEnd()) { async = true; nextToken(); }
    if (isP(P.STAR)) { generator = true; nextToken(); }
    let kind = 0;
    if ((isK(K.GET) || isK(K.SET)) && !nextIsPropertyEnd()) {
        kind = isK(K.GET) ? 1 : 2;
        nextToken();
    }
    let key: NodeId;
    if (isP(P.LBRACKET)) {
        nextToken();
        // class index signature `[k: string]: T` (vs computed key `[expr]`)
        if (tsMode && isIdentLike()) {
            const s = saveState();
            const name = parseIdent();
            if (isP(P.COLON)) {
                const keyAnn = parseTypeAnn();
                const param = make.Param(ast, ast.start[name], tokStart, 0, name, keyAnn, 0);
                expectP(P.RBRACKET, "']'");
                let ann = 0;
                if (isP(P.COLON)) ann = parseTypeAnn();
                consumeSemi();
                return make.TSIndexSig(ast, start, tokStart, flags & FL.READONLY, param, ann);
            }
            restoreState(s);
        }
        flags |= FL.COMPUTED;
        key = parseAssign();
        expectP(P.RBRACKET, "']'");
    } else if ((tok as number) === T_STR) { key = addNode(ast, N.Str, tokStart, tokEnd, 0, 0, 0); nextToken(); }
    else if (tok === T_NUM) { key = addNode(ast, N.Num, tokStart, tokEnd, 0, 0, 0); nextToken(); }
    else if (tok === T_PRIVATE) key = parsePrivate();
    else key = parseNameAsIdent();

    // ctor?
    if (kind === 0 && ast.type[key] === N.Ident && src.startsWith('constructor', ast.start[key]) && ast.end[key] - ast.start[key] === 11)
        kind = 3;

    // optional marker sits BEFORE the method/field distinction: `m?(): T {}`
    if (tsMode && isP(P.QUESTION)) { flags |= FL.OPTIONAL; nextToken(); }

    if (kind !== 0 || async || generator || isP(P.LPAREN) || (tsMode && isP(P.LT))) {
        const fn = parseMethodTail(start, (async ? FL.ASYNC : 0) | (generator ? FL.GENERATOR : 0));
        return make.MethodDef(ast, start, tokStart, flags | (kind << FL.KIND_SHIFT), key, fn);
    }
    if (tsMode && isP(P.BANG)) { flags |= FL.DEFINITE; nextToken(); }
    let typeAnn = 0;
    if (tsMode && isP(P.COLON)) typeAnn = parseTypeAnn();
    let value = 0;
    if (isP(P.EQ)) { nextToken(); value = parseAssign(); }
    consumeSemi();
    return make.PropDef(ast, start, tokStart, flags, key, typeAnn, value);
}

function isAccessModifier(): boolean {
    const len = tokEnd - tokStart;
    return (
        (len === 6 && src.startsWith('public', tokStart)) ||
        (len === 7 && src.startsWith('private', tokStart)) ||
        (len === 9 && src.startsWith('protected', tokStart))
    );
}

/* -------------------------------------------------------------- statements */

function parseBlock(): NodeId {
    const start = tokStart;
    expectP(P.LBRACE, "'{'");
    const from = sp;
    while (!isP(P.RBRACE) && (tok as number) !== T_EOF) push(parseStatement());
    expectP(P.RBRACE, "'}'");
    return make.Block(ast, start, tokStart, 0, finishList(from));
}

function parseStatement(): NodeId {
    const start = tokStart;
    if (tok === T_PUNCT) {
        switch (tokVal as number) {
            case P.LBRACE: return parseBlock();
            case P.SEMI: nextToken(); return addNode(ast, N.Empty, start, tokStart, 0, 0, 0);
            case P.AT: err('decorators not supported'); nextToken(); return parseStatement();
        }
    }
    if (tok === T_KW) {
        switch (tokVal as number) {
            case K.VAR: return parseVarDecl(VAR_KIND.VAR, 0);
            case K.CONST: {
                const s = saveState();
                nextToken();
                if (tsMode && isK(K.ENUM)) return parseEnum(start, FL.CONST_ENUM);
                restoreState(s);
                return parseVarDecl(VAR_KIND.CONST, 0);
            }
            case K.LET: {
                // `let` is contextual: `let x` decl vs `let` as ident
                const s = saveState();
                nextToken();
                if (isIdentLike() || isP(P.LBRACE) || isP(P.LBRACKET)) { restoreState(s); return parseVarDecl(VAR_KIND.LET, 0); }
                restoreState(s);
                break;
            }
            case K.FUNCTION: return parseFunction(false, true, false);
            case K.ASYNC: {
                const s = saveState();
                nextToken();
                if (isK(K.FUNCTION) && (tokFlags & F_NL) === 0) return parseFunction(true, true, false);
                restoreState(s);
                break;
            }
            case K.CLASS: return parseClass(false, 0);
            case K.IF: {
                nextToken();
                expectP(P.LPAREN, "'('");
                const test = parseExpression();
                expectP(P.RPAREN, "')'");
                const cons = parseStatement();
                let alt = 0;
                if (eatK(K.ELSE)) alt = parseStatement();
                return make.If(ast, start, tokStart, 0, test, cons, alt);
            }
            case K.FOR: return parseFor(start);
            case K.WHILE: {
                nextToken();
                expectP(P.LPAREN, "'('");
                const test = parseExpression();
                expectP(P.RPAREN, "')'");
                const body = parseStatement();
                return make.While(ast, start, ast.end[body], 0, test, body);
            }
            case K.DO: {
                nextToken();
                const body = parseStatement();
                if (!eatK(K.WHILE)) err("expected 'while'");
                expectP(P.LPAREN, "'('");
                const test = parseExpression();
                expectP(P.RPAREN, "')'");
                eatP(P.SEMI);
                return make.DoWhile(ast, start, tokStart, 0, body, test);
            }
            case K.SWITCH: {
                nextToken();
                expectP(P.LPAREN, "'('");
                const disc = parseExpression();
                expectP(P.RPAREN, "')'");
                expectP(P.LBRACE, "'{'");
                const from = sp;
                while (!isP(P.RBRACE) && (tok as number) !== T_EOF) {
                    const cs = tokStart;
                    let test = 0;
                    if (eatK(K.CASE)) { test = parseExpression(); }
                    else if (!eatK(K.DEFAULT)) { err("expected 'case'"); nextToken(); continue; }
                    expectP(P.COLON, "':'");
                    const bodyFrom = sp;
                    while (!isP(P.RBRACE) && !isK(K.CASE) && !isK(K.DEFAULT) && (tok as number) !== T_EOF) push(parseStatement());
                    const body = finishList(bodyFrom);
                    push(make.SwitchCase(ast, cs, tokStart, 0, test, body));
                }
                expectP(P.RBRACE, "'}'");
                return make.Switch(ast, start, tokStart, 0, disc, finishList(from));
            }
            case K.TRY: {
                nextToken();
                const block = parseBlock();
                let handler = 0;
                let finalizer = 0;
                if (isK(K.CATCH)) {
                    const cs = tokStart;
                    nextToken();
                    let param = 0;
                    if (eatP(P.LPAREN)) {
                        param = parseBindingTarget();
                        if (tsMode && isP(P.COLON)) parseTypeAnn(); // catch clause type — dropped
                        expectP(P.RPAREN, "')'");
                    }
                    const cbody = parseBlock();
                    handler = make.CatchClause(ast, cs, tokStart, 0, param, cbody);
                }
                if (eatK(K.FINALLY)) finalizer = parseBlock();
                return make.Try(ast, start, tokStart, 0, block, handler, finalizer);
            }
            case K.RETURN: {
                nextToken();
                let arg = 0;
                if (!canInsertSemi() && !isP(P.SEMI)) arg = parseExpression();
                consumeSemi();
                return make.Return(ast, start, tokStart, 0, arg);
            }
            case K.THROW: {
                nextToken();
                const arg = parseExpression();
                consumeSemi();
                return make.Throw(ast, start, tokStart, 0, arg);
            }
            case K.BREAK: case K.CONTINUE: {
                const isBreak = tokVal === K.BREAK;
                nextToken();
                let label = 0;
                if (isIdentLike() && (tokFlags & F_NL) === 0) label = parseIdent();
                consumeSemi();
                return isBreak ? make.Break(ast, start, tokStart, 0, label) : make.Continue(ast, start, tokStart, 0, label);
            }
            case K.DEBUGGER: nextToken(); consumeSemi(); return addNode(ast, N.Debugger, start, tokStart, 0, 0, 0);
            case K.IMPORT: {
                const s = saveState();
                nextToken();
                if (isP(P.LPAREN) || isP(P.DOT)) { restoreState(s); break; } // import() / import.meta expression
                restoreState(s);
                return parseImport();
            }
            case K.EXPORT: return parseExport();
            case K.INTERFACE:
                if (tsMode) return parseInterface(start, 0);
                break;
            case K.TYPE:
                if (tsMode) {
                    const s = saveState();
                    nextToken();
                    if (isIdentLike() && (tokFlags & F_NL) === 0) { restoreState(s); return parseTypeAlias(start, 0); }
                    restoreState(s);
                }
                break;
            case K.ENUM:
                if (tsMode) return parseEnum(start, 0);
                break;
            case K.DECLARE:
                if (tsMode) {
                    const s = saveState();
                    nextToken();
                    if (tok === T_KW && (tokVal === K.CONST || tokVal === K.LET || tokVal === K.VAR || tokVal === K.FUNCTION ||
                        tokVal === K.CLASS || tokVal === K.INTERFACE || tokVal === K.TYPE || tokVal === K.ENUM ||
                        tokVal === K.NAMESPACE || tokVal === K.MODULE || tokVal === K.ABSTRACT || tokVal === K.ASYNC)) {
                        const inner = parseStatement();
                        ast.flags[inner] |= FL.DECLARE;
                        ast.start[inner] = start;
                        return inner;
                    }
                    restoreState(s);
                }
                break;
            case K.ABSTRACT:
                if (tsMode) {
                    const s = saveState();
                    const abstractStart = tokStart;
                    nextToken();
                    if (isK(K.CLASS)) return parseClass(false, FL.ABSTRACT, abstractStart);
                    restoreState(s);
                }
                break;
            case K.NAMESPACE: case K.MODULE:
                if (tsMode) {
                    const s = saveState();
                    nextToken();
                    if (isIdentLike() || (tok as number) === T_STR) {
                        const id = (tok as number) === T_STR ? (addNode(ast, N.Str, tokStart, tokEnd, 0, 0, 0)) : parseIdent();
                        if ((tok as number) === T_STR) nextToken();
                        if (isP(P.LBRACE)) {
                            nextToken();
                            const from = sp;
                            while (!isP(P.RBRACE) && (tok as number) !== T_EOF) push(parseStatement());
                            expectP(P.RBRACE, "'}'");
                            return make.TSModuleDecl(ast, start, tokStart, FL.NAMESPACE, id, finishList(from));
                        }
                    }
                    restoreState(s);
                }
                break;
        }
    }
    // labeled statement or expression statement
    const expr = parseExpression();
    if (ast.type[expr] === N.Ident && isP(P.COLON)) {
        nextToken();
        const body = parseStatement();
        return make.Labeled(ast, start, ast.end[body], 0, expr, body);
    }
    consumeSemi();
    return make.ExprStmt(ast, start, tokStart, 0, expr);
}

function parseVarDecl(kind: number, extraFlags: number): NodeId {
    const start = tokStart;
    nextToken();
    const from = sp;
    do {
        const ds = tokStart;
        const target = parseBindingTarget();
        let flags = 0;
        if (tsMode && isP(P.BANG)) { flags |= FL.DEFINITE; nextToken(); }
        let typeAnn = 0;
        if (tsMode && isP(P.COLON)) typeAnn = parseTypeAnn();
        let init = 0;
        if (isP(P.EQ)) { nextToken(); init = parseAssign(); }
        push(make.VarDeclarator(ast, ds, tokStart, flags, target, typeAnn, init));
    } while (eatP(P.COMMA));
    consumeSemi();
    return make.VarDecl(ast, start, tokStart, kind | extraFlags, finishList(from));
}

function parseFor(start: number): NodeId {
    nextToken();
    let flags = 0;
    if (eatK(K.AWAIT)) flags |= FL.AWAIT;
    expectP(P.LPAREN, "'('");
    let init = 0;
    if (isP(P.SEMI)) nextToken();
    else {
        if (tok === T_KW && (tokVal === K.VAR || tokVal === K.LET || tokVal === K.CONST)) {
            const kind = tokVal === K.VAR ? VAR_KIND.VAR : tokVal === K.LET ? VAR_KIND.LET : VAR_KIND.CONST;
            const ds = tokStart;
            nextToken();
            const target = parseBindingTarget();
            if (isK(K.OF) || isK(K.IN)) {
                const isOf = isK(K.OF);
                nextToken();
                const dtor = make.VarDeclarator(ast, ds, tokStart, 0, target, 0, 0);
                const decl = make.VarDecl(ast, ds, tokStart, kind, addList(ast, [dtor]));
                const right = isOf ? parseAssign() : parseExpression();
                expectP(P.RPAREN, "')'");
                const body = parseStatement();
                return isOf
                    ? make.ForOf(ast, start, ast.end[body], flags, decl, right, body)
                    : make.ForIn(ast, start, ast.end[body], 0, decl, right, body);
            }
            const dFrom = sp;
            {
                let typeAnn = 0;
                let dflags = 0;
                if (tsMode && isP(P.BANG)) { dflags |= FL.DEFINITE; nextToken(); }
                if (tsMode && isP(P.COLON)) typeAnn = parseTypeAnn();
                let dinit = 0;
                if (isP(P.EQ)) { nextToken(); dinit = parseAssign(true); }
                push(make.VarDeclarator(ast, ds, tokStart, dflags, target, typeAnn, dinit));
            }
            while (eatP(P.COMMA)) {
                const ds2 = tokStart;
                const t2 = parseBindingTarget();
                let typeAnn = 0;
                if (tsMode && isP(P.COLON)) typeAnn = parseTypeAnn();
                let dinit = 0;
                if (isP(P.EQ)) { nextToken(); dinit = parseAssign(true); }
                push(make.VarDeclarator(ast, ds2, tokStart, 0, t2, typeAnn, dinit));
            }
            init = make.VarDecl(ast, ds, tokStart, kind, finishList(dFrom));
            expectP(P.SEMI, "';'");
        } else {
            init = parseExpression(true);
            if (isK(K.OF) || isK(K.IN)) {
                const isOf = tokVal === K.OF;
                nextToken();
                const right = isOf ? parseAssign() : parseExpression();
                expectP(P.RPAREN, "')'");
                const body = parseStatement();
                return isOf
                    ? make.ForOf(ast, start, ast.end[body], flags, init, right, body)
                    : make.ForIn(ast, start, ast.end[body], 0, init, right, body);
            }
            expectP(P.SEMI, "';'");
        }
    }
    let test = 0;
    if (!isP(P.SEMI)) test = parseExpression();
    expectP(P.SEMI, "';'");
    let update = 0;
    if (!isP(P.RPAREN)) update = parseExpression();
    expectP(P.RPAREN, "')'");
    const body = parseStatement();
    return make.For(ast, start, ast.end[body], 0, init, test, update, body);
}

/* ---------------------------------------------------------------- modules */

function parseImport(): NodeId {
    const start = tokStart;
    nextToken();
    let flags = 0;
    if (tsMode && isK(K.TYPE)) {
        const s = saveState();
        nextToken();
        if (!isK(K.FROM) && !isP(P.EQ)) flags |= FL.TYPE_ONLY;
        else restoreState(s);
    }
    const from = sp;
    if ((tok as number) === T_STR) { // side-effect import
        const source = addNode(ast, N.Str, tokStart, tokEnd, 0, 0, 0);
        nextToken();
        consumeSemi();
        return make.ImportDecl(ast, start, tokStart, flags, finishList(from), source);
    }
    if (isIdentLike()) {
        const local = parseIdent();
        push(make.ImportDefaultSpec(ast, ast.start[local], ast.end[local], 0, local));
        eatP(P.COMMA);
    }
    if (isP(P.STAR)) {
        const s = tokStart;
        nextToken();
        if (!eatK(K.AS)) err("expected 'as'");
        const local = parseIdent();
        push(make.ImportNamespaceSpec(ast, s, ast.end[local], 0, local));
    } else if (isP(P.LBRACE)) {
        nextToken();
        while (!isP(P.RBRACE) && (tok as number) !== T_EOF) {
            const ss = tokStart;
            let specFlags = 0;
            if (tsMode && isK(K.TYPE)) {
                const st = saveState();
                nextToken();
                if (isNameLike() || (tok as number) === T_STR) specFlags |= FL.TYPE_ONLY;
                else restoreState(st);
            }
            const imported = (tok as number) === T_STR ? (addNode(ast, N.Str, tokStart, tokEnd, 0, 0, 0)) : parseNameAsIdent();
            if ((tok as number) === T_STR) nextToken();
            let local = imported;
            if (eatK(K.AS)) local = parseIdent();
            push(make.ImportSpec(ast, ss, tokStart, specFlags, local, imported));
            if (!isP(P.RBRACE)) expectP(P.COMMA, "','");
        }
        expectP(P.RBRACE, "'}'");
    }
    if (!eatK(K.FROM)) err("expected 'from'");
    let source = 0;
    if ((tok as number) === T_STR) { source = addNode(ast, N.Str, tokStart, tokEnd, 0, 0, 0); nextToken(); }
    else err('expected module specifier');
    consumeSemi();
    return make.ImportDecl(ast, start, tokStart, flags, finishList(from), source);
}

function parseExport(): NodeId {
    const start = tokStart;
    nextToken();
    if (eatK(K.DEFAULT)) {
        let decl: NodeId;
        if (isK(K.FUNCTION)) decl = parseFunction(false, true, false);
        else if (isK(K.ASYNC)) { nextToken(); decl = parseFunction(true, true, false); }
        else if (isK(K.CLASS)) decl = parseClass(false, 0);
        else { decl = parseAssign(); consumeSemi(); }
        return make.ExportDefault(ast, start, tokStart, 0, decl);
    }
    if (isP(P.STAR)) {
        nextToken();
        let exported = 0;
        if (eatK(K.AS)) exported = parseIdent();
        if (!eatK(K.FROM)) err("expected 'from'");
        let source = 0;
        if ((tok as number) === T_STR) { source = addNode(ast, N.Str, tokStart, tokEnd, 0, 0, 0); nextToken(); }
        consumeSemi();
        return make.ExportAll(ast, start, tokStart, 0, source, exported);
    }
    let flags = 0;
    if (tsMode && isK(K.TYPE)) {
        const s = saveState();
        nextToken();
        if (isP(P.LBRACE)) flags |= FL.TYPE_ONLY;
        else { restoreState(s); }
    }
    if (isP(P.LBRACE)) {
        nextToken();
        const from = sp;
        while (!isP(P.RBRACE) && (tok as number) !== T_EOF) {
            const ss = tokStart;
            let specFlags = 0;
            if (tsMode && isK(K.TYPE)) {
                const st = saveState();
                nextToken();
                if (isNameLike()) specFlags |= FL.TYPE_ONLY;
                else restoreState(st);
            }
            const local = (tok as number) === T_STR ? (addNode(ast, N.Str, tokStart, tokEnd, 0, 0, 0)) : parseNameAsIdent();
            if ((tok as number) === T_STR) nextToken();
            let exported = local;
            if (eatK(K.AS)) exported = (tok as number) === T_STR ? (addNode(ast, N.Str, tokStart, tokEnd, 0, 0, 0)) : parseNameAsIdent();
            if (ast.type[exported] === N.Str) nextToken();
            push(make.ExportSpec(ast, ss, tokStart, specFlags, local, exported));
            if (!isP(P.RBRACE)) expectP(P.COMMA, "','");
        }
        expectP(P.RBRACE, "'}'");
        let source = 0;
        if (eatK(K.FROM)) {
            if ((tok as number) === T_STR) { source = addNode(ast, N.Str, tokStart, tokEnd, 0, 0, 0); nextToken(); }
        }
        consumeSemi();
        return make.ExportNamed(ast, start, tokStart, flags, 0, finishList(from), source);
    }
    // export <declaration>
    const decl = parseStatement();
    return make.ExportNamed(ast, start, tokStart, flags, decl, addList(ast, []), 0);
}

/* ------------------------------------------------------------- TS declels */

function parseInterface(start: number, extraFlags: number): NodeId {
    nextToken();
    const id = parseIdent();
    let typeParams = 0;
    if (isP(P.LT)) { const t = tryParseTypeParams(); if (t !== -1) typeParams = t; }
    const extFrom = sp;
    if (eatK(K.EXTENDS)) {
        do {
            const s = tokStart;
            let expr = parseIdent();
            while (isP(P.DOT)) { nextToken(); const r = parseNameAsIdent(); expr = make.TSQualifiedName(ast, s, ast.end[r], 0, expr, r); }
            let targs = 0;
            if (isP(P.LT)) { const t = tryParseTypeArgsInType(); if (t !== -1) targs = t; }
            push(make.TSHeritage(ast, s, tokStart, 0, expr, targs));
        } while (eatP(P.COMMA));
    }
    const ext = finishList(extFrom);
    const body = parseTypeMembers();
    return make.TSInterfaceDecl(ast, start, tokStart, extraFlags, id, typeParams, ext, body);
}

function parseTypeAlias(start: number, extraFlags: number): NodeId {
    nextToken();
    const id = parseIdent();
    let typeParams = 0;
    if (isP(P.LT)) { const t = tryParseTypeParams(); if (t !== -1) typeParams = t; }
    expectP(P.EQ, "'='");
    const ty = parseType();
    consumeSemi();
    return make.TSTypeAliasDecl(ast, start, tokStart, extraFlags, id, typeParams, ty);
}

function parseEnum(start: number, extraFlags: number): NodeId {
    nextToken();
    const id = parseIdent();
    expectP(P.LBRACE, "'{'");
    const from = sp;
    while (!isP(P.RBRACE) && (tok as number) !== T_EOF) {
        const ms = tokStart;
        let key: NodeId;
        if ((tok as number) === T_STR) { key = addNode(ast, N.Str, tokStart, tokEnd, 0, 0, 0); nextToken(); }
        else key = parseNameAsIdent();
        let init = 0;
        if (isP(P.EQ)) { nextToken(); init = parseAssign(); }
        push(make.TSEnumMember(ast, ms, tokStart, 0, key, init));
        if (!isP(P.RBRACE)) expectP(P.COMMA, "','");
    }
    expectP(P.RBRACE, "'}'");
    return make.TSEnumDecl(ast, start, tokStart, extraFlags, id, finishList(from));
}

/* ------------------------------------------------------------- TS types */

function parseTypeAnn(): NodeId {
    const start = tokStart; // the ':'
    expectP(P.COLON, "':'");
    // asserts / type predicates: `asserts x is T`, `x is T` — model as the inner type
    if (isK(K.ASSERTS)) {
        nextToken();
        if (isIdentLike() || isK(K.THIS)) nextToken();
        if (eatK(K.IS)) parseType();
        return make.TSTypeAnn(ast, start, tokStart, 0, make.TSKeyword(ast, start, tokStart, TSK.ANY));
    }
    const s = saveState();
    if (isIdentLike() || isK(K.THIS)) {
        nextToken();
        if (isK(K.IS)) {
            nextToken();
            const ty = parseType();
            return make.TSTypeAnn(ast, start, tokStart, 0, ty);
        }
        restoreState(s);
    }
    const ty = parseType();
    return make.TSTypeAnn(ast, start, ast.end[ty], 0, ty);
}

function parseType(): NodeId {
    if (isP(P.LPAREN) && fnTypeAhead()) return parseFnType(0, 0);
    if (isP(P.LT)) {
        const tp = tryParseTypeParams();
        if (tp !== -1) return parseFnType(0, tp);
    }
    if (isK(K.NEW)) {
        const start = tokStart;
        nextToken();
        let tp = 0;
        if (isP(P.LT)) { const t = tryParseTypeParams(); if (t !== -1) tp = t; }
        const params = parseParams();
        expectP(P.ARROW, "'=>'");
        const ret = parseType();
        const ann = make.TSTypeAnn(ast, ast.start[ret], ast.end[ret], 0, ret);
        return make.TSCtorType(ast, start, tokStart, 0, tp, params, ann);
    }
    return parseUnionType();
}

function parseFnType(abstractFlag: number, typeParams: number): NodeId {
    const start = tokStart;
    const params = parseParams();
    expectP(P.ARROW, "'=>'");
    const ret = parseType();
    const ann = make.TSTypeAnn(ast, ast.start[ret], ast.end[ret], 0, ret);
    return make.TSFunctionType(ast, start, tokStart, abstractFlag, typeParams, params, ann);
}

/** is `( ... ) =>` ahead? raw scan like arrowAheadFromParen (bracket depth only — `=>` must not count) */
function fnTypeAhead(): boolean {
    let p = tokStart + 1;
    let depth = 1;
    while (p < srcLen && depth > 0) {
        const c = src.charCodeAt(p);
        if (c === 40 || c === 91 || c === 123) depth++;
        else if (c === 41 || c === 93 || c === 125) depth--;
        else if (c === 34 || c === 39 || c === 96) {
            const q = c;
            p++;
            while (p < srcLen && src.charCodeAt(p) !== q) p += src.charCodeAt(p) === 92 ? 2 : 1;
        }
        p++;
    }
    while (p < srcLen) {
        const c = src.charCodeAt(p);
        if (c < 128 && (CHAR[c] === C_WS || CHAR[c] === C_NL)) p++;
        else break;
    }
    return src.charCodeAt(p) === 61 && src.charCodeAt(p + 1) === 62;
}

function parseUnionType(): NodeId {
    eatP(P.PIPE); // leading |
    let first = parseIntersectionType();
    if (!isP(P.PIPE)) return parseCondTail(first);
    const start = ast.start[first];
    const from = sp;
    push(first);
    while (eatP(P.PIPE)) push(parseIntersectionType());
    const u = make.TSUnion(ast, start, tokStart, 0, finishList(from));
    return parseCondTail(u);
}

function parseIntersectionType(): NodeId {
    eatP(P.AMP);
    const first = parseTypeOperator();
    if (!isP(P.AMP)) return first;
    const start = ast.start[first];
    const from = sp;
    push(first);
    while (eatP(P.AMP)) push(parseTypeOperator());
    return make.TSIntersection(ast, start, tokStart, 0, finishList(from));
}

function parseCondTail(checkType: NodeId): NodeId {
    if (!isK(K.EXTENDS)) return checkType;
    nextToken();
    const extendsType = parseIntersectionType();
    if (!isP(P.QUESTION)) {
        // heritage-style extends inside another context — shouldn't happen at this level
        expectP(P.QUESTION, "'?'");
        return checkType;
    }
    nextToken();
    const trueType = parseType();
    expectP(P.COLON, "':'");
    const falseType = parseType();
    return make.TSConditional(ast, ast.start[checkType], ast.end[falseType], 0, checkType, extendsType, trueType, falseType);
}

function parseTypeOperator(): NodeId {
    const start = tokStart;
    if (isK(K.KEYOF)) { nextToken(); const t = parseTypeOperator(); return make.TSTypeOperator(ast, start, ast.end[t], TSOP.KEYOF, t); }
    if (isK(K.READONLY)) { nextToken(); const t = parseTypeOperator(); return make.TSTypeOperator(ast, start, ast.end[t], TSOP.READONLY, t); }
    if (isK(K.UNIQUE)) { nextToken(); const t = parseTypeOperator(); return make.TSTypeOperator(ast, start, ast.end[t], TSOP.UNIQUE, t); }
    if (isK(K.INFER)) {
        nextToken();
        const name = parseIdent();
        const tp = make.TSTypeParam(ast, ast.start[name], ast.end[name], 0, name, 0, 0);
        return make.TSInfer(ast, start, tokStart, 0, tp);
    }
    return parseTypePostfixAndCond(parsePrimaryType());
}

function parseTypePostfixAndCond(t: NodeId): NodeId {
    for (;;) {
        if (isP(P.LBRACKET) && (tokFlags & F_NL) === 0) {
            nextToken();
            if (isP(P.RBRACKET)) { nextToken(); t = make.TSArrayType(ast, ast.start[t], tokStart, 0, t); }
            else {
                const idx = parseType();
                expectP(P.RBRACKET, "']'");
                t = make.TSIndexedAccess(ast, ast.start[t], tokStart, 0, t, idx);
            }
        } else return t;
    }
}

function parsePrimaryType(): NodeId {
    const start = tokStart;
    if (isP(P.LPAREN)) {
        if (fnTypeAhead()) return parseFnType(0, 0);
        nextToken();
        const t = parseType();
        expectP(P.RPAREN, "')'");
        return t;
    }
    if ((tok as number) === T_STR) { const l = addNode(ast, N.Str, start, tokEnd, 0, 0, 0); nextToken(); return make.TSLiteralType(ast, start, tokStart, 0, l); }
    if (tok === T_NUM) { const l = addNode(ast, N.Num, start, tokEnd, 0, 0, 0); nextToken(); return make.TSLiteralType(ast, start, tokStart, 0, l); }
    if (tok === T_BIGINT) { const l = addNode(ast, N.BigInt, start, tokEnd, 0, 0, 0); nextToken(); return make.TSLiteralType(ast, start, tokStart, 0, l); }
    if (tok === T_TEMPLATE_FULL || tok === T_TEMPLATE_HEAD) {
        // template literal type — reuse template parsing with types in the holes
        return parseTemplateLiteralType();
    }
    if (isP(P.MINUS)) { // negative literal type
        nextToken();
        if (tok === T_NUM) { const l = addNode(ast, N.Num, start, tokEnd, 0, 0, 0); nextToken(); return make.TSLiteralType(ast, start, tokStart, 0, l); }
        err('expected number');
        return make.TSKeyword(ast, start, tokStart, TSK.ANY);
    }
    if (isP(P.LBRACKET)) { // tuple type
        nextToken();
        const from = sp;
        while (!isP(P.RBRACKET) && (tok as number) !== T_EOF) {
            if (isP(P.DOTDOTDOT)) {
                const s = tokStart;
                nextToken();
                // labeled rest member: `...rest: T[]`
                const sv = saveState();
                let t = 0;
                if (isIdentLike()) {
                    const label = parseIdent();
                    let opt = 0;
                    if (isP(P.QUESTION)) { opt = FL.OPTIONAL; nextToken(); }
                    if (isP(P.COLON)) {
                        nextToken();
                        const ty = parseType();
                        t = make.TSNamedTupleMember(ast, ast.start[label], ast.end[ty], opt, label, ty);
                    } else restoreState(sv);
                }
                if (t === 0) t = parseType();
                push(make.TSTypeOperator(ast, s, ast.end[t], 0, t)); // rest marker: op 0
            } else {
                // named member? `label: T` / `label?: T`
                const s = saveState();
                if (isIdentLike()) {
                    const label = parseIdent();
                    let opt = 0;
                    if (isP(P.QUESTION)) { opt = FL.OPTIONAL; nextToken(); }
                    if (isP(P.COLON)) {
                        nextToken();
                        const t = parseType();
                        push(make.TSNamedTupleMember(ast, ast.start[label], ast.end[t], opt, label, t));
                        if (!isP(P.RBRACKET)) expectP(P.COMMA, "','");
                        continue;
                    }
                    restoreState(s);
                }
                push(parseType());
            }
            if (!isP(P.RBRACKET)) expectP(P.COMMA, "','");
        }
        expectP(P.RBRACKET, "']'");
        return make.TSTuple(ast, start, tokStart, 0, finishList(from));
    }
    if (isP(P.LBRACE)) {
        // mapped type? { [K in T]: U } — lookahead for '[' ident 'in'
        if (mappedTypeAhead()) return parseMappedType();
        const members = parseTypeMembers();
        return make.TSTypeLit(ast, start, tokStart, 0, members);
    }
    if (isK(K.TYPEOF)) {
        nextToken();
        const s = tokStart;
        let expr = parseIdent();
        while (isP(P.DOT)) { nextToken(); const r = parseNameAsIdent(); expr = make.TSQualifiedName(ast, s, ast.end[r], 0, expr, r); }
        let targs = 0;
        if (isP(P.LT)) { const t = tryParseTypeArgsInType(); if (t !== -1) targs = t; }
        return make.TSTypeQuery(ast, start, tokStart, 0, expr, targs);
    }
    if (isK(K.IMPORT)) {
        nextToken();
        expectP(P.LPAREN, "'('");
        let source = 0;
        if ((tok as number) === T_STR) { source = addNode(ast, N.Str, tokStart, tokEnd, 0, 0, 0); nextToken(); }
        expectP(P.RPAREN, "')'");
        let qualifier = 0;
        if (isP(P.DOT)) {
            nextToken();
            qualifier = parseNameAsIdent();
            while (isP(P.DOT)) { nextToken(); const r = parseNameAsIdent(); qualifier = make.TSQualifiedName(ast, ast.start[qualifier], ast.end[r], 0, qualifier, r); }
        }
        let targs = 0;
        if (isP(P.LT)) { const t = tryParseTypeArgsInType(); if (t !== -1) targs = t; }
        return make.TSImportType(ast, start, tokStart, 0, source, qualifier, targs);
    }
    if (isK(K.THIS)) { nextToken(); return make.TSKeyword(ast, start, tokStart, TSK.THIS); }
    if (isIdentLike() || tok === T_KW) {
        // keyword types by span text
        const kw = tsKeywordType();
        if (kw !== 0) { nextToken(); return make.TSKeyword(ast, start, tokStart, kw); }
        const s = tokStart;
        let name = parseNameAsIdent();
        while (isP(P.DOT)) { nextToken(); const r = parseNameAsIdent(); name = make.TSQualifiedName(ast, s, ast.end[r], 0, name, r); }
        let targs = 0;
        if (isP(P.LT)) {
            const t = tryParseTypeArgsInType();
            if (t !== -1) targs = t;
        }
        return make.TSTypeRef(ast, start, tokStart, 0, name, targs);
    }
    err('expected type');
    nextToken();
    return make.TSKeyword(ast, start, tokStart, TSK.ANY);
}

function tsKeywordType(): number {
    const len = tokEnd - tokStart;
    const st = tokStart;
    switch (len) {
        case 3: if (src.startsWith('any', st)) return TSK.ANY; break;
        case 4: if (src.startsWith('void', st)) return TSK.VOID; break;
        case 5: if (src.startsWith('never', st)) return TSK.NEVER; break;
        case 6:
            if (src.startsWith('number', st)) return TSK.NUMBER;
            if (src.startsWith('string', st)) return TSK.STRING;
            if (src.startsWith('symbol', st)) return TSK.SYMBOL;
            if (src.startsWith('object', st)) return TSK.OBJECT;
            if (src.startsWith('bigint', st)) return TSK.BIGINT;
            break;
        case 7:
            if (src.startsWith('boolean', st)) return TSK.BOOLEAN;
            if (src.startsWith('unknown', st)) return TSK.UNKNOWN;
            break;
        case 9: if (src.startsWith('undefined', st)) return TSK.UNDEFINED; break;
    }
    if (isK(K.NULL)) return TSK.NULL;
    return 0;
}

function parseTemplateLiteralType(): NodeId {
    const start = tokStart;
    if (tok === T_TEMPLATE_FULL) {
        const q = addNode(ast, N.TemplateElement, start + 1, tokEnd - 1, 0, 0, 0);
        nextToken();
        return make.TSTemplateLiteralType(ast, start, tokStart, 0, addList(ast, [q]), 0);
    }
    const qFrom = sp;
    const types: number[] = [];
    push(addNode(ast, N.TemplateElement, start + 1, tokEnd - 2, 0, 0, 0));
    nextToken();
    for (;;) {
        types.push(parseType());
        if (!isP(P.RBRACE)) { err("expected '}'"); break; }
        reScanTemplateContinue();
        if (tok === T_TEMPLATE_FULL) {
            push(addNode(ast, N.TemplateElement, tokStart + 1, tokEnd - 1, 0, 0, 0));
            nextToken();
            break;
        }
        push(addNode(ast, N.TemplateElement, tokStart + 1, tokEnd - 2, 0, 0, 0));
        nextToken();
    }
    const quasis = finishList(qFrom);
    const tFrom = sp;
    for (const t of types) push(t);
    return make.TSTemplateLiteralType(ast, start, tokStart, 0, quasis, finishList(tFrom));
}

function mappedTypeAhead(): boolean {
    const s = saveState();
    nextToken();
    let ok = false;
    if (isP(P.PLUS) || isP(P.MINUS)) nextToken();
    if (isK(K.READONLY)) nextToken();
    if (isP(P.LBRACKET)) {
        nextToken();
        if (isIdentLike()) {
            nextToken();
            ok = isK(K.IN);
        }
    }
    restoreState(s);
    return ok;
}

function parseMappedType(): NodeId {
    const start = tokStart;
    nextToken();
    let flags = 0;
    if (isP(P.PLUS)) { nextToken(); if (eatK(K.READONLY)) flags |= 1 << 4; }
    else if (isP(P.MINUS)) { nextToken(); if (eatK(K.READONLY)) flags |= 2 << 4; }
    else if (eatK(K.READONLY)) flags |= 3 << 4;
    expectP(P.LBRACKET, "'['");
    const name = parseIdent();
    if (!eatK(K.IN)) err("expected 'in'");
    const constraint = parseType();
    let nameType = 0;
    if (eatK(K.AS)) nameType = parseType();
    expectP(P.RBRACKET, "']'");
    if (isP(P.PLUS)) { nextToken(); if (eatP(P.QUESTION)) flags |= 1 << 6; }
    else if (isP(P.MINUS)) { nextToken(); if (eatP(P.QUESTION)) flags |= 2 << 6; }
    else if (eatP(P.QUESTION)) flags |= 3 << 6;
    let typeAnn = 0;
    if (isP(P.COLON)) { nextToken(); typeAnn = parseType(); }
    eatP(P.SEMI);
    expectP(P.RBRACE, "'}'");
    const tp = make.TSTypeParam(ast, ast.start[name], ast.end[constraint], 0, name, constraint, 0);
    return make.TSMapped(ast, start, tokStart, flags, tp, nameType, typeAnn);
}

function parseTypeMembers(): number {
    expectP(P.LBRACE, "'{'");
    const from = sp;
    let last = -1;
    while (!isP(P.RBRACE) && (tok as number) !== T_EOF) {
        if (tokStart === last) { err('unexpected token in type member'); nextToken(); continue; }
        last = tokStart;
        push(parseTypeMember());
        eatP(P.COMMA);
        eatP(P.SEMI);
    }
    expectP(P.RBRACE, "'}'");
    return finishList(from);
}

function parseTypeMember(): NodeId {
    const start = tokStart;
    let flags = 0;
    if (isK(K.READONLY) && !nextIsPropertyEnd()) { flags |= FL.READONLY; nextToken(); }
    if (isK(K.NEW) && !nextIsPropertyEnd()) {
        // ctor signature
        nextToken();
        let tp = 0;
        if (isP(P.LT)) { const t = tryParseTypeParams(); if (t !== -1) tp = t; }
        const params = parseParams();
        let ret = 0;
        if (isP(P.COLON)) ret = parseTypeAnn();
        return make.TSCtorSig(ast, start, tokStart, 0, tp, params, ret);
    }
    if (isP(P.LPAREN) || isP(P.LT)) {
        // call signature
        let tp = 0;
        if (isP(P.LT)) { const t = tryParseTypeParams(); if (t !== -1) tp = t; }
        const params = parseParams();
        let ret = 0;
        if (isP(P.COLON)) ret = parseTypeAnn();
        return make.TSCallSig(ast, start, tokStart, 0, tp, params, ret);
    }
    if (isP(P.LBRACKET)) {
        // index signature `[k: string]: T` vs computed key `[A.B]: T`
        nextToken();
        const ps = tokStart;
        const name = parseNameAsIdent();
        if (isP(P.COLON)) {
            const keyAnn = parseTypeAnn();
            const param = make.Param(ast, ps, tokStart, 0, name, keyAnn, 0);
            expectP(P.RBRACKET, "']'");
            let ann = 0;
            if (isP(P.COLON)) ann = parseTypeAnn();
            return make.TSIndexSig(ast, start, tokStart, flags, param, ann);
        }
        // computed key: member chain like Enum.MEMBER (or any expression path)
        let key: NodeId = name;
        while (isP(P.DOT)) {
            nextToken();
            const r = parseNameAsIdent();
            key = make.Member(ast, ps, ast.end[r], 0, key, r);
        }
        expectP(P.RBRACKET, "']'");
        let mflags = flags | FL.COMPUTED;
        if (isP(P.QUESTION)) { mflags |= FL.OPTIONAL; nextToken(); }
        if (isP(P.LPAREN) || isP(P.LT)) {
            let tp = 0;
            if (isP(P.LT)) { const t = tryParseTypeParams(); if (t !== -1) tp = t; }
            const params = parseParams();
            let ret = 0;
            if (isP(P.COLON)) ret = parseTypeAnn();
            return make.TSMethodSig(ast, start, tokStart, mflags, key, tp, params, ret);
        }
        let ann = 0;
        if (isP(P.COLON)) ann = parseTypeAnn();
        return make.TSPropSig(ast, start, tokStart, mflags, key, ann);
    }
    let kind = 0;
    if ((isK(K.GET) || isK(K.SET)) && !nextIsPropertyEnd()) { kind = isK(K.GET) ? 1 : 2; nextToken(); }
    let key: NodeId;
    if ((tok as number) === T_STR) { key = addNode(ast, N.Str, tokStart, tokEnd, 0, 0, 0); nextToken(); }
    else if (tok === T_NUM) { key = addNode(ast, N.Num, tokStart, tokEnd, 0, 0, 0); nextToken(); }
    else key = parseNameAsIdent();
    if (isP(P.QUESTION)) { flags |= FL.OPTIONAL; nextToken(); }
    if (isP(P.LPAREN) || isP(P.LT) || kind !== 0) {
        let tp = 0;
        if (isP(P.LT)) { const t = tryParseTypeParams(); if (t !== -1) tp = t; }
        const params = parseParams();
        let ret = 0;
        if (isP(P.COLON)) ret = parseTypeAnn();
        return make.TSMethodSig(ast, start, tokStart, flags | (kind << FL.KIND_SHIFT), key, tp, params, ret);
    }
    let ann = 0;
    if (isP(P.COLON)) ann = parseTypeAnn();
    return make.TSPropSig(ast, start, tokStart, flags, key, ann);
}

/** '>' inside nested type args may arrive as >> >>> >= etc. — split it */
function expectGtInType(): void {
    if (isP(P.GT)) { nextToken(); return; }
    if (tok === T_PUNCT && (tokVal === P.SHR || tokVal === P.USHR || tokVal === P.GE || tokVal === P.SHREQ || tokVal === P.USHREQ)) {
        pos = tokStart + 1;
        nextToken();
        return;
    }
    err("expected '>'");
}
const isGtLike = (): boolean =>
    tok === T_PUNCT && (tokVal === P.GT || tokVal === P.SHR || tokVal === P.USHR || tokVal === P.GE || tokVal === P.SHREQ || tokVal === P.USHREQ);

/** parse `<T, U extends V = W>`. Returns a TSTypeParams NodeId or -1 (restores state) */
function tryParseTypeParams(): number {
    const s = saveState();
    const startPos = tokStart; // the '<'
    nextToken();
    const from = sp;
    try {
        speculating++;
        while (!isGtLike() && (tok as number) !== T_EOF) {
            const ts = tokStart;
            let flags = 0;
            for (;;) {
                if (isK(K.IN)) { flags |= 1; nextToken(); }
                else if (tok === T_IDENT && tokEnd - tokStart === 3 && src.startsWith('out', tokStart) && !nextIsTypeParamEnd()) { flags |= 2; nextToken(); }
                else if (isK(K.CONST)) { flags |= 4; nextToken(); }
                else break;
            }
            const name = parseIdent();
            let constraint = 0;
            if (eatK(K.EXTENDS)) constraint = parseType();
            let dflt = 0;
            if (isP(P.EQ)) { nextToken(); dflt = parseType(); }
            push(make.TSTypeParam(ast, ts, tokStart, flags, name, constraint, dflt));
            if (!eatP(P.COMMA)) break;
        }
        if (!isGtLike()) throw 0;
        expectGtInType();
        speculating--;
        // child slots hold NodeIds — wrap the list in its TSTypeParams node
        return make.TSTypeParams(ast, startPos, tokStart, 0, finishList(from));
    } catch {
        speculating--;
        sp = from;
        restoreState(s);
        return -1;
    }
}

function nextIsTypeParamEnd(): boolean {
    const s = saveState();
    nextToken();
    const end = isGtLike() || isP(P.COMMA) || isK(K.EXTENDS) || isP(P.EQ);
    restoreState(s);
    return end;
}

/** type args in type context (no call-follow requirement). Returns TSTypeArgs NodeId or -1. */
function tryParseTypeArgsInType(): number {
    const s = saveState();
    const startPos = tokStart; // the '<'
    nextToken();
    const from = sp;
    try {
        speculating++;
        while (!isGtLike() && (tok as number) !== T_EOF) {
            push(parseType());
            if (!eatP(P.COMMA)) break;
        }
        if (!isGtLike()) throw 0;
        expectGtInType();
        speculating--;
        // child slots hold NodeIds — wrap the list in its TSTypeArgs node
        return make.TSTypeArgs(ast, startPos, tokStart, 0, finishList(from));
    } catch {
        speculating--;
        sp = from;
        restoreState(s);
        return -1;
    }
}

/** type args in expression context: valid only if followed by '(' or template */
function tryParseTypeArgsForCall(): number {
    const s = saveState();
    const ref = tryParseTypeArgsInType();
    if (ref === -1) return -1;
    if (isP(P.LPAREN) || tok === T_TEMPLATE_FULL || tok === T_TEMPLATE_HEAD || isP(P.RPAREN) || isP(P.COMMA) || isP(P.SEMI) || isP(P.RBRACE) || tok === T_EOF) {
        return ref;
    }
    restoreState(s);
    return -1;
}

/* ------------------------------------------------------------------ entry */

/** Parsed program: the populated AST arena and its root Program node id. */
export type ParseResult = {
    ast: Ast;
    program: NodeId;
};

/** Parser options; `ts: true` enables TypeScript syntax. */
export type ParseOptions = { ts: boolean };

/** Parse `source` into `out` (reset first, so one arena can be reused across parses) and return its Program root. */
export function parse(out: Ast, source: string, options: ParseOptions): ParseResult {
    ast = out;
    tsMode = options.ts;
    resetAst(ast, source);
    src = source;
    srcLen = source.length;
    pos = 0;
    sp = 0;
    nextToken();
    const from = sp;
    let lastPos = -1;
    while ((tok as number) !== T_EOF) {
        if (pos === lastPos && (tok as number) !== T_EOF) { err('parser stalled'); nextToken(); }
        lastPos = pos;
        push(parseStatement());
    }
    const body = finishList(from);
    const program = make.Program(ast, 0, srcLen, 0, body);
    return { ast, program };
}
