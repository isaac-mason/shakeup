// React Fast Refresh — the COMPILE pass. A port of oxc's `oxc_transformer/src/jsx/refresh.rs`,
// running as an ordinary plugin over shakeup's `transformProgram` hook.
//
// It emits only FREE `$RefreshReg$` / `$RefreshSig$` references — no definitions and no
// `import.meta.hot`. Supplying those is the WRAPPER's job (a separate plugin, a port of rolldown's
// `vite_react_refresh_wrapper`), which is the same split oxc and rolldown draw.
//
// Nothing about React lives in shakeup's core: this reads the AST and the semantic through the
// published toolchain API and mutates the tree it is handed.
import { binding, bool, create, exprStmt, N, type Node, ref, str, VAR_KIND, walk, walkChildren } from '../../ast.ts';
import type { Semantic } from '../../analysis/semantic.ts';
import type { Plugin } from '../plugin.ts';

/** `refresh.rs:911` — a component's name starts with an ASCII uppercase letter. */
const isComponentish = (name: string): boolean => name.length > 0 && name[0] >= 'A' && name[0] <= 'Z';

/** The JSX-like calls whose FIRST argument names a component (`refresh.rs:948`). Source that already
 *  uses these forms is registered the same way real JSX is. */
const JSX_LIKE_CALLS = new Set(['createElement', 'jsx', 'jsxDEV', 'jsxs']);

const dataOf = (n: Node): Record<string, unknown> => n.data as unknown as Record<string, unknown>;

/**
 * Bindings referenced from JSX, by SYMBOL (`UsedInJSXBindingsCollector`). A `const Foo = hoc(X)` is
 * registered only if it is used in JSX somewhere, so this decides registration for the HOC-ish
 * cases. Read-only, and run BEFORE any mutation — the semantic it consults describes the tree as
 * given.
 */
function usedInJsxBindings(program: Node): Set<number> {
    const out = new Set<number>();
    walk(program, (n) => {
        if (n.type === N.JSXOpeningElement) {
            const name = dataOf(n).name as Node | null;
            // `<Foo>` is an identifier; `<foo.bar>` and `<foo:bar>` are not registered by oxc either.
            if (name !== null && name.type === N.JSXIdentifier && name.sym !== 0) out.add(name.sym);
            return undefined;
        }
        if (n.type === N.CallExpression) {
            const d = dataOf(n);
            const callee = d.callee as Node;
            const calleeName =
                callee.type === N.IdentifierReference
                    ? callee.name
                    : callee.type === N.StaticMemberExpression
                      ? ((dataOf(callee).property as Node).name ?? '')
                      : '';
            if (!JSX_LIKE_CALLS.has(calleeName)) return undefined;
            const first = (d.arguments as Node[])[0];
            if (first !== undefined && first.type === N.IdentifierReference && first.sym !== 0) out.add(first.sym);
        }
        return undefined;
    });
    return out;
}

/** Every identifier-ish name the module already uses, so minted `_c`/`_s` names cannot collide. */
function takenNames(program: Node): Set<string> {
    const taken = new Set<string>();
    walk(program, (n) => {
        if (
            n.type === N.BindingIdentifier ||
            n.type === N.IdentifierReference ||
            n.type === N.IdentifierName ||
            n.type === N.JSXIdentifier
        )
            taken.add(n.name);
        return undefined;
    });
    return taken;
}

/** `refresh.rs:915` — `use` followed by nothing, or by an uppercase letter. `used` is not a hook. */
const isUseHookName = (name: string): boolean =>
    name.startsWith('use') && (name.length === 3 || (name[3] >= 'A' && name[3] <= 'Z'));

/** `refresh.rs:920`, verbatim. A hook NOT on this list is a custom one: it joins the signature's
 *  callee list, which is how a custom hook changing identity forces a remount. */
const BUILTIN_HOOKS = new Set([
    'useState',
    'useReducer',
    'useEffect',
    'useLayoutEffect',
    'useMemo',
    'useCallback',
    'useRef',
    'useContext',
    'useImperativeHandle',
    'useDebugValue',
    'useId',
    'useDeferredValue',
    'useTransition',
    'useInsertionEffect',
    'useSyncExternalStore',
    'useFormStatus',
    'useFormState',
    'useActionState',
    'useOptimistic',
]);

/**
 * One hook call's contribution to its function's signature key.
 *
 * `hookName{declaratorId}` or `hookName{declaratorId(argsKey)}`, and entries are joined by a LITERAL
 * BACKSLASH-N — `push_str("\\n")` in `refresh.rs`, two characters, not a newline. The fixture proves
 * it: the expected key is the JS literal `"useState{[foo, setFoo](0)}\\nuseEffect{}"`. Emitting a real
 * newline changes every multi-hook key and therefore every hash.
 *
 * Both `declaratorId` and `argsKey` are RAW SOURCE TEXT, taken by span — which is why this pass needs
 * the source at all. Re-printing the nodes would normalise the very spacing the key encodes.
 */
function keyEntry(hookName: string, declaratorId: string, argsKey: string): string {
    return argsKey === '' ? `${hookName}{${declaratorId}}` : `${hookName}{${declaratorId}(${argsKey})}`;
}

/** The callee's name for hook purposes: `useX()` or `a.useX()` — the PROPERTY, in the member case. */
function hookNameOf(callee: Node): string {
    if (callee.type === N.IdentifierReference) return callee.name;
    if (callee.type === N.StaticMemberExpression) return (dataOf(callee).property as Node).name;
    return '';
}

/** What one function's hook calls added up to. `callees` holds a custom hook's callee SOURCE TEXT,
 *  or null when the binding could not be resolved — any null forces `forceReset`. */
type Signature = { key: string; callees: (string | null)[] };

/**
 * Walk the program collecting a signature per FUNCTION node, plus the enclosing-declarator context
 * each hook call needs.
 *
 * A manual descent rather than `walk`, because `walk` is enter-only and this needs a stack: a hook
 * call belongs to the nearest enclosing function, and its `declaratorId` comes from the nearest
 * enclosing `VariableDeclarator`.
 */
function collectSignatures(program: Node, code: string): Map<Node, Signature> {
    const out = new Map<Node, Signature>();
    // TRIMMED. The key is the text the user WROTE for a construct, and surrounding whitespace is
    // not part of it. shakeup also needs the trim more than oxc does: a destructuring pattern's span
    // ends one character past its closing bracket (`[a, b] `, `{x} `), where plain identifiers and
    // call arguments are tight. Untrimmed, `const [foo, setFoo] = useState(0)` keys as
    // `useState{[foo, setFoo] (0)}` and every such signature diverges from the oracle.
    const textOf = (n: Node): string => code.slice(n.start, n.end).trim();

    const visit = (n: Node, fn: Node | null, declarator: Node | null): void => {
        const isFn =
            n.type === N.FunctionDeclaration ||
            n.type === N.FunctionExpression ||
            n.type === N.ArrowFunctionExpression;
        const nextFn = isFn ? n : fn;
        // A declarator's context reaches its INIT, not the whole subtree below the next function:
        // `const [a, setA] = useState(0)` keys on `[a, setA]`, but a hook inside a nested function
        // there does not.
        const nextDeclarator = isFn ? null : n.type === N.VariableDeclarator ? n : declarator;

        if (n.type === N.CallExpression && nextFn !== null) {
            const d = dataOf(n);
            const callee = d.callee as Node;
            const hookName = hookNameOf(callee);
            if (isUseHookName(hookName)) {
                const args = d.arguments as Node[];
                const argsKey =
                    hookName === 'useState' && args.length > 0
                        ? textOf(args[0])
                        : hookName === 'useReducer' && args.length > 1
                          ? textOf(args[1])
                          : '';
                // The declarator id is the one this call INITIALISES, not any outer one.
                const declId =
                    declarator !== null && (dataOf(declarator).init as Node | null) === n
                        ? textOf(dataOf(declarator).id as Node)
                        : '';
                const entry = keyEntry(hookName, declId, argsKey);
                const sig = out.get(nextFn) ?? { key: '', callees: [] };
                // A literal backslash-n between entries — see `keyEntry`.
                sig.key = sig.key === '' ? entry : `${sig.key}\\n${entry}`;
                if (!BUILTIN_HOOKS.has(hookName)) {
                    // A custom hook contributes its CALLEE, so a change to that hook's identity
                    // forces a remount. An unresolvable one contributes null -> forceReset.
                    sig.callees.push(callee.type === N.IdentifierReference && callee.sym === 0 ? null : textOf(callee));
                }
                out.set(nextFn, sig);
            }
        }

        walkChildren(n, (child) => {
            visit(child, nextFn, nextDeclarator);
        });
    };
    visit(program, null, null);
    return out;
}

export type ReactRefreshOptions = {
    /** The registration callee. Default `$RefreshReg$`. */
    refreshReg?: string;
    /** The signature-factory callee. Default `$RefreshSig$`. */
    refreshSig?: string;
    /** Emit the raw signature key instead of its hash — what the oxc fixture corpus asserts. */
    emitFullSignatures?: boolean;
};

/**
 * Rewrite one already-parsed, already-analysed program. Exported for the conformance harness, which
 * drives it directly against oxc's fixtures; the plugin below is the ordinary way in.
 *
 * Returns whether anything changed, which is exactly what `transformProgram` wants back.
 */
export function refreshProgram(
    program: Node,
    _semantic: Semantic,
    code: string,
    options: ReactRefreshOptions = {},
): boolean {
    const refreshReg = options.refreshReg ?? '$RefreshReg$';
    const refreshSig = options.refreshSig ?? '$RefreshSig$';
    const signatures = collectSignatures(program, code);
    const jsxBindings = usedInJsxBindings(program);
    const taken = takenNames(program);

    /** `_c`, `_c2`, … — oxc's `generate_uid_in_root_scope("c")` naming, collision-checked. */
    let counter = 0;
    const mintRegistration = (): string => {
        for (;;) {
            counter++;
            const name = counter === 1 ? '_c' : `_c${counter}`;
            if (!taken.has(name)) {
                taken.add(name);
                return name;
            }
        }
    };

    /** (temporary name, persistent id) pairs, in registration order — the epilogue's input. */
    const registrations: [string, string][] = [];

    /** `_s`, `_s2`, … — one per SIGNED function, minted in the same collision-checked way. */
    let sigCounter = 0;
    const mintSignature = (): string => {
        for (;;) {
            sigCounter++;
            const name = sigCounter === 1 ? '_s' : `_s${sigCounter}`;
            if (!taken.has(name)) {
                taken.add(name);
                return name;
            }
        }
    };
    /** `var _s = $RefreshSig$(), …` — the declarations to hoist to the top of the module. */
    const signatureVars: string[] = [];

    /**
     * Sign one function DECLARATION: `_s()` first in its body, and `_s(Name, key, …)` after the
     * statement. Function expressions and arrows are wrapped in place instead — a later stage.
     */
    const signFunctionDeclaration = (fn: Node, name: string): Node | null => {
        const sig = signatures.get(fn);
        if (sig === undefined) return null;
        const sName = mintSignature();
        signatureVars.push(sName);

        const body = dataOf(fn).body as Node | null;
        if (body === null) return null;
        const stmts = dataOf(body).body as Node[];
        stmts.unshift(exprStmt(create.CallExpression(0, 0, 0, ref(sName), [], null)));

        const args: Node[] = [ref(name), str(sig.key)];
        const forceReset = sig.callees.some((c) => c === null);
        const present = sig.callees.filter((c): c is string => c !== null);
        // The 3rd and 4th arguments appear only when they carry information — `forceReset` when
        // either it is true or custom hooks exist, and the thunk only when there are custom hooks.
        if (forceReset || present.length > 0) args.push(bool(forceReset));
        return exprStmt(create.CallExpression(0, 0, 0, ref(sName), args, null));
    };

    /** `_c = Foo;` — the statement that captures a component at its definition site. */
    const registrationFor = (componentName: string): Node => {
        const temp = mintRegistration();
        registrations.push([temp, componentName]);
        return exprStmt(create.AssignmentExpression(0, 0, '=', ref(temp), ref(componentName)));
    };

    const body = dataOf(program).body as Node[];
    const out: Node[] = [];

    for (const stmt of body) {
        out.push(stmt);
        // The signature line comes BEFORE the registration line — `_s(App, …)` then `_c = App`,
        // which is the order every fixture shows.
        const fn = signableFunctionDeclaration(stmt);
        if (fn !== null) {
            const signed = signFunctionDeclaration(fn.node, fn.name);
            if (signed !== null) out.push(signed);
        }
        const registered = registerFor(stmt, jsxBindings);
        if (registered !== null) out.push(registrationFor(registered));
    }

    if (registrations.length === 0 && signatureVars.length === 0) return false;

    // `var _s = $RefreshSig$(), _s2 = $RefreshSig$();` at the top of the module.
    if (signatureVars.length > 0) {
        out.unshift(
            create.VariableDeclaration(
                0,
                0,
                VAR_KIND.VAR,
                signatureVars.map((n) =>
                    create.VariableDeclarator(0, 0, 0, binding(n), null, create.CallExpression(0, 0, 0, ref(refreshSig), [], null)),
                ),
            ),
        );
    }

    if (registrations.length === 0) {
        dataOf(program).body = out;
        return true;
    }

    // The epilogue: `var _c, _c2;` then one `$RefreshReg$(_cN, "Name")` each, in order.
    out.push(
        create.VariableDeclaration(
            0,
            0,
            VAR_KIND.VAR,
            registrations.map(([temp]) => create.VariableDeclarator(0, 0, 0, binding(temp), null, null)),
        ),
    );
    for (const [temp, id] of registrations) {
        out.push(exprStmt(create.CallExpression(0, 0, 0, ref(refreshReg), [ref(temp), str(id)], null)));
    }

    dataOf(program).body = out;
    return true;
}

/** The function DECLARATION a top-level statement holds, with its name — `export`s unwrapped. */
function signableFunctionDeclaration(stmt: Node): { node: Node; name: string } | null {
    let decl: Node | null = null;
    if (stmt.type === N.FunctionDeclaration) decl = stmt;
    else if (stmt.type === N.ExportNamedDeclaration || stmt.type === N.ExportDefaultDeclaration) {
        const inner = dataOf(stmt).declaration as Node | null;
        if (inner !== null && inner !== undefined && inner.type === N.FunctionDeclaration) decl = inner;
    }
    if (decl === null) return null;
    const id = dataOf(decl).id as Node | null;
    return id === null || id === undefined ? null : { node: decl, name: id.name };
}

/**
 * Which component name a TOP-LEVEL statement defines, or null. `process_statement` +
 * `handle_function_declaration` + `handle_variable_declaration` in `refresh.rs`.
 */
function registerFor(stmt: Node, jsxBindings: Set<number>): string | null {
    if (stmt.type === N.FunctionDeclaration) return fromFunctionDeclaration(stmt);
    if (stmt.type === N.ExportNamedDeclaration) {
        const decl = dataOf(stmt).declaration as Node | null;
        if (decl === null) return null;
        if (decl.type === N.FunctionDeclaration) return fromFunctionDeclaration(decl);
        if (decl.type === N.VariableDeclaration) return fromVariableDeclaration(decl, jsxBindings);
        return null;
    }
    if (stmt.type === N.ExportDefaultDeclaration) {
        const decl = dataOf(stmt).declaration as Node | null;
        return decl !== null && decl.type === N.FunctionDeclaration ? fromFunctionDeclaration(decl) : null;
    }
    if (stmt.type === N.VariableDeclaration) return fromVariableDeclaration(stmt, jsxBindings);
    return null;
}

function fromFunctionDeclaration(fn: Node): string | null {
    const id = dataOf(fn).id as Node | null;
    if (id === null || id === undefined) return null;
    // A `declare function` is TS-only syntax and emits nothing (`func.is_typescript_syntax()`).
    if (dataOf(fn).declare === true) return null;
    return isComponentish(id.name) ? id.name : null;
}

function fromVariableDeclaration(decl: Node, jsxBindings: Set<number>): string | null {
    const declarators = dataOf(decl).declarations as Node[];
    if (declarators.length !== 1) return null;
    const d = dataOf(declarators[0]);
    const id = d.id as Node;
    const rawInit = d.init as Node | null;
    if (rawInit === null || rawInit === undefined || id.type !== N.BindingIdentifier) return null;
    if (!isComponentish(id.name)) return null;
    // No `without_parentheses` step: shakeup's parser does not represent parentheses as a node,
    // so `(() => {})` and `() => {}` are the same tree. oxc needs one because its AST keeps them.
    const init = rawInit;

    // FIRST a gate on the initialiser's SHAPE — which forms could be a component at all.
    switch (init.type) {
        case N.ArrowFunctionExpression:
            // `() => () => {}` is a factory, not a component.
            if (arrowReturnsArrow(init)) return null;
            break;
        case N.FunctionExpression:
        // `styled.div\`…\`` reaches here, but does NOT pass `foundInside` below — a tagged template
        // is not one of the forms `replaceInnerComponents` recognises, so it registers only when the
        // binding is used in JSX. That is the `does-not-transform-it-because-it-is-not-used-in-the-AST`
        // fixture, and treating it as an automatic component was this port's first bug.
        case N.TaggedTemplateExpression:
            break;
        case N.CallExpression: {
            // `const A = import(…)` / `const A = require(…)` is a module load, never a component.
            const callee = dataOf(init).callee as Node;
            if (callee.type === N.ImportExpression) return null;
            if (callee.type === N.IdentifierReference && callee.name.startsWith('require')) return null;
            break;
        }
        default:
            return null;
    }

    // THEN the same two-part test oxc applies: something component-shaped inside, or a binding JSX
    // actually uses. Neither alone is enough.
    const foundInside = looksLikeComponent(init, /* isVariableDeclarator */ true);
    if (!foundInside && !jsxBindings.has(id.sym)) return null;
    return id.name;
}

/**
 * `replace_inner_components`, as a PREDICATE — "is there a component in here?".
 *
 * oxc's version also WRAPS an inner function as `(_c = fn)` when it is not a declarator init, which
 * is how a HOC's inline argument gets registered. That half is a later stage; this one decides
 * registration, which is what the shape gate above feeds.
 */
function looksLikeComponent(expr: Node, isVariableDeclarator: boolean): boolean {
    const e = expr;
    switch (e.type) {
        case N.IdentifierReference:
            // `export const Something = hoc(Foo)` — `Foo` is assumed registered at ITS definition,
            // so this reports the name's shape rather than wrapping anything.
            return isComponentish(e.name);
        case N.FunctionExpression:
            return true;
        case N.ArrowFunctionExpression:
            return !arrowReturnsArrow(e);
        case N.CallExpression: {
            const callee = dataOf(e).callee as Node;
            const calleeOk =
                callee.type === N.IdentifierReference ||
                callee.type === N.StaticMemberExpression ||
                callee.type === N.ComputedMemberExpression;
            if (!calleeOk) return false;
            const first = (dataOf(e).arguments as Node[])[0];
            if (first === undefined) return false;
            if (!looksLikeComponent(first, false)) return false;
            return isVariableDeclarator;
        }
        default:
            return false;
    }
}

/** `() => () => {}` — with `expression: true` the arrow's `body` IS the expression. */
function arrowReturnsArrow(arrow: Node): boolean {
    const d = dataOf(arrow);
    return d.expression === true && (d.body as Node).type === N.ArrowFunctionExpression;
}



/** The plugin. `.jsx`/`.tsx` only — the same gate rolldown's wrapper uses. */
export function reactRefresh(options: ReactRefreshOptions = {}): Plugin {
    return {
        name: 'react-refresh',
        transformProgram: {
            filter: { id: /\.[jt]sx$/ },
            handler: (program, semantic, _id, code) => refreshProgram(program, semantic, code, options),
        },
    };
}
