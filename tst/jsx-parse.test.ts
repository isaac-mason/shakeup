import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { N, type Node, walk } from '../src/ast.ts';
import { parse } from '../src/parser.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JSX_DIR = resolve(__dirname, 'fixtures/jsx');

function parseJSX(src: string, ts = false) {
    return parse(src, { ts, jsx: true });
}

function collect(src: string, ts: boolean, pred: (n: Node) => boolean): { type: number; name: string }[] {
    const { program } = parseJSX(src, ts);
    const out: { type: number; name: string }[] = [];
    walk(program, (n: Node) => {
        if (pred(n)) out.push({ type: n.type, name: n.name });
    });
    return out;
}
function hasType(src: string, ts: boolean, type: number): boolean {
    const { program } = parseJSX(src, ts);
    let found = false;
    walk(program, (n: Node) => {
        if (n.type === type) found = true;
    });
    return found;
}

describe('JSX fixtures parse with zero errors', () => {
    const files = readdirSync(JSX_DIR).sort();
    it('found the fixture corpus (.jsx + .tsx)', () => {
        expect(files.some((f) => f.endsWith('.jsx'))).toBe(true);
        expect(files.some((f) => f.endsWith('.tsx'))).toBe(true);
    });
    for (const f of files) {
        it(`parses ${f} with 0 errors`, () => {
            const src = readFileSync(resolve(JSX_DIR, f), 'utf8');
            const ts = f.endsWith('.tsx');
            const { errors } = parseJSX(src, ts);
            expect(errors, JSON.stringify(errors)).toEqual([]);
        });
    }
});

describe('JSX AST shape', () => {
    it('element: opening/closing/name/attributes/children', () => {
        expect(hasType('<div className="a">hi</div>;', false, N.JSXElement)).toBe(true);
        expect(hasType('<div className="a">hi</div>;', false, N.JSXOpeningElement)).toBe(true);
        expect(hasType('<div className="a">hi</div>;', false, N.JSXClosingElement)).toBe(true);
        expect(hasType('<div className="a">hi</div>;', false, N.JSXAttribute)).toBe(true);
        expect(hasType('<div className="a">hi</div>;', false, N.JSXText)).toBe(true);
    });

    it('self-closing element has no children and no closing element', () => {
        const { program } = parseJSX('<img src="x" />;');
        let el: Node | null = null;
        walk(program, (n) => {
            if (n.type === N.JSXElement) el = n;
        });
        const data = (el as unknown as { data: { children: Node[]; closingElement: Node | null } }).data;
        expect(data.children).toEqual([]);
        expect(data.closingElement).toBeNull();
    });

    it('fragment: JSXFragment + opening/closing fragment leaves', () => {
        expect(hasType('<><a/><b/></>;', false, N.JSXFragment)).toBe(true);
        expect(hasType('<><a/><b/></>;', false, N.JSXOpeningFragment)).toBe(true);
        expect(hasType('<><a/><b/></>;', false, N.JSXClosingFragment)).toBe(true);
    });

    it('expression container in children and attribute value', () => {
        expect(hasType('<div id={x}>{y}</div>;', false, N.JSXExpressionContainer)).toBe(true);
    });

    it('empty / comment-only container is a JSXEmptyExpression', () => {
        expect(hasType('<div>{}</div>;', false, N.JSXEmptyExpression)).toBe(true);
        expect(hasType('<div>{/* c */}</div>;', false, N.JSXEmptyExpression)).toBe(true);
    });

    it('spread attribute vs spread child', () => {
        expect(hasType('<div {...props} />;', false, N.JSXSpreadAttribute)).toBe(true);
        expect(hasType('<ul>{...items}</ul>;', false, N.JSXSpreadChild)).toBe(true);
    });

    it('namespaced name (tag and attribute)', () => {
        expect(hasType('<a:b />;', false, N.JSXNamespacedName)).toBe(true);
        expect(hasType('<a x:y="z" />;', false, N.JSXNamespacedName)).toBe(true);
    });

    it('dashed intrinsic is a single JSXIdentifier carrying the dash', () => {
        const ids = collect('<foo-bar />;', false, (n) => n.type === N.JSXIdentifier);
        expect(ids.map((i) => i.name)).toContain('foo-bar');
    });

    it('member-expression head (`A.B.C`)', () => {
        expect(hasType('<A.B.C />;', false, N.JSXMemberExpression)).toBe(true);
    });
});

describe('JSX head role split (plan §6)', () => {
    it('lowercase intrinsic tag head is a JSXIdentifier (never resolves)', () => {
        const opening = collect('<div />;', false, (n) => n.type === N.JSXIdentifier);
        expect(opening.map((i) => i.name)).toContain('div');
    });

    it('capitalized component tag head is an IdentifierReference (value ref)', () => {
        const refs = collect('<Foo />;', false, (n) => n.type === N.IdentifierReference);
        expect(refs.map((r) => r.name)).toContain('Foo');
        const jsxIds = collect('<Foo />;', false, (n) => n.type === N.JSXIdentifier);
        expect(jsxIds.map((i) => i.name)).not.toContain('Foo');
    });

    it('member head object is an IdentifierReference; properties are JSXIdentifier', () => {
        const refs = collect('<Menu.Item />;', false, (n) => n.type === N.IdentifierReference);
        expect(refs.map((r) => r.name)).toContain('Menu');
        const jsxIds = collect('<Menu.Item />;', false, (n) => n.type === N.JSXIdentifier);
        expect(jsxIds.map((i) => i.name)).toContain('Item');
    });

    it('`this` / `this.Foo` head is a ThisExpression', () => {
        expect(hasType('<this />;', false, N.ThisExpression)).toBe(true);
        expect(hasType('<this.Foo />;', false, N.ThisExpression)).toBe(true);
    });

    it('attribute names are JSXIdentifier (never resolve)', () => {
        const jsxIds = collect('<div onClick={h} />;', false, (n) => n.type === N.JSXIdentifier);
        expect(jsxIds.map((i) => i.name)).toContain('onClick');
    });
});

describe('JSXText holds RAW source (no entity decode in P1)', () => {
    it('entities and irregular whitespace are preserved verbatim in the name slot', () => {
        const texts = collect('<p>a &amp; b   c</p>;', false, (n) => n.type === N.JSXText);
        expect(texts.map((t) => t.name).join('')).toBe('a &amp; b   c');
    });
});

describe('tsx generic-arrow vs JSX ambiguity (plan §3c)', () => {
    const tsxArrows = [
        'const f = <T,>() => x;',
        'const f = <T extends X>() => x;',
        'const f = <T,>(a: T): T => a;',
        'const f = <T = number>(a: T) => a;',
    ];
    for (const src of tsxArrows) {
        it(`tsx: \`${src}\` is a generic arrow, not JSX`, () => {
            const { errors } = parseJSX(src, true);
            expect(errors, JSON.stringify(errors)).toEqual([]);
            expect(hasType(src, true, N.ArrowFunctionExpression)).toBe(true);
            expect(hasType(src, true, N.JSXElement)).toBe(false);
        });
    }

    it('tsx: bare `<T>() => x` (paren follows) is an arrow', () => {
        expect(hasType('const g = <T>() => x;', true, N.ArrowFunctionExpression)).toBe(true);
        expect(hasType('const g = <T>() => x;', true, N.JSXElement)).toBe(false);
    });

    it('tsx: bare `<T>hi</T>` (no paren) is JSX', () => {
        expect(hasType('const el = <T>hi</T>;', true, N.JSXElement)).toBe(true);
        expect(hasType('const el = <T>hi</T>;', true, N.ArrowFunctionExpression)).toBe(false);
    });

    it('tsx: generic component tag `<Comp<T> />` carries typeArguments', () => {
        const { program, errors } = parseJSX('const el = <Comp<T> foo="x" />;', true);
        expect(errors, JSON.stringify(errors)).toEqual([]);
        let opening: Node | null = null;
        walk(program, (n) => {
            if (n.type === N.JSXOpeningElement) opening = n;
        });
        const ta = (opening as unknown as { data: { typeArguments: Node | null } }).data.typeArguments;
        expect(ta).not.toBeNull();
        expect(ta!.type).toBe(N.TSTypeParameterInstantiation);
    });
});

describe('generic arrows in plain .ts still parse (regression)', () => {
    for (const src of ['const f = <T,>() => x;', 'const g = <T extends X>() => x;', 'const h = <T = string>(a: T) => a;']) {
        it(`plain .ts (jsx:false): \`${src}\``, () => {
            const { errors, program } = parse(src, { ts: true, jsx: false });
            expect(errors, JSON.stringify(errors)).toEqual([]);
            let hasArrow = false;
            walk(program, (n) => {
                if (n.type === N.ArrowFunctionExpression) hasArrow = true;
            });
            expect(hasArrow).toBe(true);
        });
    }
});

describe('jsx:false must NOT parse JSX (negative)', () => {
    for (const src of ['const x = <div>hi</div>;', 'const y = <Foo />;', 'const z = <>frag</>;']) {
        it(`rejects \`${src}\` cleanly (errors, no JSX nodes)`, () => {
            const { program, errors } = parse(src, { ts: false, jsx: false });
            expect(errors.length).toBeGreaterThan(0);
            let hasJSX = false;
            walk(program, (n) => {
                if (n.type >= N.JSXElement && n.type <= N.JSXText) hasJSX = true;
            });
            expect(hasJSX).toBe(false);
        });
    }
});
