// React Fast Refresh — the COMPILE pass. A port of oxc's `oxc_transformer/src/jsx/refresh.rs`,
// running as an ordinary plugin over shakeup's `transformProgram` hook.
//
// It emits only FREE `$RefreshReg$` / `$RefreshSig$` references — no definitions and no
// `import.meta.hot`. Supplying those is the WRAPPER's job (a separate plugin, a port of rolldown's
// `vite_react_refresh_wrapper`), which is the same split oxc and rolldown draw.
//
// Nothing about React lives in shakeup's core: this reads the AST and the semantic through the
// published toolchain API and mutates the tree it is handed.
import {
    binding,
    bool,
    cloneNode,
    create,
    exprStmt,
    idName,
    member,
    N,
    type Node,
    ref,
    set,
    str,
    statementListOf,
    VAR_KIND,
    walk,
    walkChildren,
} from '../../ast.ts';
import { lookupValue, type Semantic } from '../../analysis/semantic.ts';
import { base64, sha1 } from '../../util/sha1.ts';
import type { Plugin } from '../plugin.ts';

/** Wrap an expression as `(_cN = expr)` and remember the registration. */
type WrapFn = (inferredName: string, expr: Node) => void;

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

/**
 * Which BINDING a non-builtin hook call depends on, and how to name it again.
 *
 * `useHook()` -> `useHook`; `Fancy.useHook()` -> `Fancy` plus one member; `Fancy.prop.useHook()` ->
 * `Fancy` plus two. Deeper than that — `A.B.C.useHook()` — contributes NOTHING: oxc supports one
 * extra member level and no more (citing facebook/react#35318), so such a call adds a key entry but
 * no callee, and therefore no `forceReset` either. The fixture proves it: `_s(Bar, "useHook{}")`,
 * two arguments.
 */
function hookCalleeBinding(callee: Node): { name: string; middle: string | null } | null {
    if (callee.type === N.IdentifierReference) return { name: callee.name, middle: null };
    if (callee.type !== N.StaticMemberExpression) return null;
    const object = dataOf(callee).object as Node;
    if (object.type === N.IdentifierReference) return { name: object.name, middle: null };
    if (object.type !== N.StaticMemberExpression) return null;
    const inner = dataOf(object).object as Node;
    if (inner.type !== N.IdentifierReference) return null;
    return { name: inner.name, middle: (dataOf(object).property as Node).name };
}

/**
 * Parse a `refreshReg`/`refreshSig` option into the expression to CALL — oxc's
 * `RefreshIdentifierResolver::parse`. Three forms, and only these:
 *
 *     $RefreshReg$              a bare identifier
 *     window.$RefreshReg$       one member off an identifier
 *     import.meta.refreshReg    `import.meta`, optionally with one property
 *
 * Built as a real expression rather than an identifier whose NAME contains dots. That shortcut
 * prints correctly and is a malformed AST: every later pass — jsxLower, the bundler's scope
 * analysis, deconfliction — would treat `import.meta.refreshReg` as one renameable binding.
 */
function refreshCallee(spec: string): Node {
    const parts = spec.split('.');
    if (parts.length === 1) return ref(spec);
    if (parts[0] === 'import' && parts[1] === 'meta') {
        const meta = create.ImportMeta(0, 0, 0);
        return parts[2] === undefined ? meta : member(meta, idName(parts[2]));
    }
    return member(ref(parts[0]), idName(parts[1]));
}

/** Rebuild the callee as an expression the signature thunk hands to the runtime. */
function calleeExpression(
    bindingRef: { name: string; middle: string | null },
    hookName: string,
    isMember: boolean,
): Node {
    let expr = ref(bindingRef.name);
    if (!isMember) return expr;
    if (bindingRef.middle !== null) expr = member(expr, idName(bindingRef.middle));
    return member(expr, idName(hookName));
}

/** The callee's name for hook purposes: `useX()` or `a.useX()` — the PROPERTY, in the member case. */
function hookNameOf(callee: Node): string {
    if (callee.type === N.IdentifierReference) return callee.name;
    if (callee.type === N.StaticMemberExpression) return (dataOf(callee).property as Node).name;
    return '';
}

/** What one function's hook calls added up to. `callees` holds a custom hook's callee SOURCE TEXT,
 *  or null when the binding could not be resolved — any null forces `forceReset`. */
type Signature = { key: string; callees: (Node | null)[]; enclosing: Node | null };

/**
 * Walk the program collecting a signature per FUNCTION node, plus the enclosing-declarator context
 * each hook call needs.
 *
 * A manual descent rather than `walk`, because `walk` is enter-only and this needs a stack: a hook
 * call belongs to the nearest enclosing function, and its `declaratorId` comes from the nearest
 * enclosing `VariableDeclarator`.
 */
function collectSignatures(program: Node, code: string, sem: Semantic): Map<Node, Signature> {
    const out = new Map<Node, Signature>();
    /** function -> the function enclosing IT. `_s` is declared in the PARENT: a signed function
     *  cannot declare the variable its own wrapper call reads. */
    const parentFn = new Map<Node, Node | null>();
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
        if (isFn) parentFn.set(n, fn);
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
                // `enclosing` is where `var _s = $RefreshSig$()` goes: the nearest enclosing FUNCTION,
                // not always the module top. The fixtures show `function hoc() { var _s3 = … }`.
                const sig = out.get(nextFn) ?? { key: '', callees: [], enclosing: parentFn.get(nextFn) ?? null };
                // A literal backslash-n between entries — see `keyEntry`.
                sig.key = sig.key === '' ? entry : `${sig.key}\\n${entry}`;
                if (!BUILTIN_HOOKS.has(hookName)) {
                    // A custom hook contributes its CALLEE, so a change to that hook's identity
                    // forces a remount.
                    const bindingRef = hookCalleeBinding(callee);
                    if (bindingRef !== null) {
                        // Resolved in the scope ENCLOSING the function — the hook is a free name
                        // there, which is oxc's lookup. Unresolved (a global like `GlobalHook`)
                        // pushes null, and any null makes the signature `forceReset`.
                        const fnScope = (dataOf(nextFn).scopeId as number | undefined) ?? 0;
                        const parentScope = sem.scopes[fnScope]?.parent ?? 0;
                        const sym = lookupValue(sem, parentScope, bindingRef.name);
                        sig.callees.push(
                            sym === 0
                                ? null
                                : calleeExpression(bindingRef, hookName, callee.type === N.StaticMemberExpression),
                        );
                    }
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
    semantic: Semantic,
    code: string,
    options: ReactRefreshOptions = {},
): boolean {
    const refreshReg = options.refreshReg ?? '$RefreshReg$';
    const refreshSig = options.refreshSig ?? '$RefreshSig$';
    // Assigned AFTER the registration pass below, not here. That pass wraps inner functions as
    // `(_c = fn)` by RETYPING the function's node and moving its contents into a clone — so a map
    // keyed on node identity before the wrap points at nodes that are no longer functions, and every
    // signature in a HOC chain silently disappears. Collecting afterwards keys on the final tree.
    let signatures = new Map<Node, Signature>();
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
    /** The `_s` names to declare, keyed by the FUNCTION they belong in (null = module top). A
     *  signed function nested inside another gets its `var _s3 = $RefreshSig$()` in that function,
     *  not at module scope — `function hoc() { var _s3 = $RefreshSig$(); … }` in the fixtures. */
    const signatureVarsByScope = new Map<Node | null, string[]>();
    const signatureVarsFor = (scope: Node | null): string[] => {
        const existing = signatureVarsByScope.get(scope);
        if (existing !== undefined) return existing;
        const fresh: string[] = [];
        signatureVarsByScope.set(scope, fresh);
        return fresh;
    };
    const signatureVars = signatureVarsFor(null);

    /** The trailing arguments of `_s(fn, …)`: the key, then `forceReset`, then the custom-hook
     *  thunk — each present only when it carries information. */
    const signatureArgs = (sig: Signature): Node[] => {
        // HASHED unless the caller asks for the raw key. oxc: SHA-1, then STANDARD base64 — which
        // is why `util/sha1.ts` exists rather than reusing `util/hash.ts` (xxHash64, radix
        // base64url: different algorithm, different alphabet).
        const args: Node[] = [str(options.emitFullSignatures === true ? sig.key : base64(sha1(sig.key)))];
        const forceReset = sig.callees.some((c) => c === null);
        const present = sig.callees.filter((c): c is Node => c !== null);
        if (forceReset || present.length > 0) args.push(bool(forceReset));
        if (present.length > 0) {
            // `function () { return [useFancyEffect]; }` — a plain function expression, as oxc
            // emits. Cloned, because each signed level of a HOC chain gets its own copy.
            const items = present.map((c) => cloneNode(c)).filter((c): c is Node => c !== null);
            const ret = create.ReturnStatement(0, 0, 0, create.ArrayExpression(0, 0, 0, items));
            args.push(
                create.FunctionExpression(0, 0, 0, null, null, [], null, create.BlockStatement(0, 0, 0, [ret])),
            );
        }
        return args;
    };

    /**
     * Sign every function EXPRESSION and arrow that calls hooks, by wrapping it where it stands:
     * `_s(fn, key)`. A declaration cannot be wrapped — it is a statement — which is why oxc emits
     * `_s(Name, key)` on the next line for those and wraps these.
     *
     * Collected first and wrapped after: `wrapInSignature` retypes the node into a call whose
     * argument is the old function, so mutating during the descent would walk the clone.
     */
    /** Statements to splice in AFTER a given statement — the next-line signatures. */
    const pendingAfter = new Map<Node, Node[]>();

    const signExpressions = (): void => {
        const pending: Node[] = [];
        // Parents, recorded as we go — the carry below has to walk UP, and there are no back-links.
        const parent = new Map<Node, Node>();
        const gather = (n: Node): void => {
            // DECLARATIONS TOO, in document order. `_s` numbering follows the order functions
            // appear, so signing all expressions first and declarations afterwards renumbers every
            // signature in a file that mixes them.
            if (
                (n.type === N.FunctionExpression ||
                    n.type === N.ArrowFunctionExpression ||
                    n.type === N.FunctionDeclaration) &&
                signatures.has(n)
            )
                pending.push(n);
            walkChildren(n, (child) => {
                parent.set(child, n);
                gather(child);
            });
        };
        gather(program);

        for (const fn of pending) {
            const sig = signatures.get(fn);
            if (sig === undefined) continue;
            const sName = mintSignature();
            signatureVarsFor(sig.enclosing).push(sName);
            const stmts = blockBodyOf(fn);
            if (stmts === null) continue;
            stmts.unshift(exprStmt(create.CallExpression(0, 0, 0, ref(sName), [], null)));

            // A function DECLARATION is a statement — it cannot be wrapped, so its signature goes
            // on the next line, under its own name.
            if (fn.type === N.FunctionDeclaration) {
                const id = dataOf(fn).id as Node | null;
                const stmt = statementContaining(fn, parent);
                if (id !== null && id !== undefined && stmt !== null) {
                    const after = pendingAfter.get(stmt) ?? [];
                    after.push(
                        exprStmt(create.CallExpression(0, 0, 0, ref(sName), [ref(id.name), ...signatureArgs(sig)], null)),
                    );
                    pendingAfter.set(stmt, after);
                }
                continue;
            }

            // A declarator's init is signed on the NEXT LINE, not wrapped: `const Foo = () => {};`
            // then `_s(Foo, key)`. Wrapping it would replace the initialiser with a call, and the
            // function would lose the name JavaScript infers from the declarator — which is what
            // `@babel/plugin-transform-react-display-name` and styled-components read.
            const up = parent.get(fn);
            const boundName =
                up !== undefined && up.type === N.VariableDeclarator && (dataOf(up).init as Node | null) === fn
                    ? (dataOf(up).id as Node)
                    : null;
            if (boundName !== null && boundName.type === N.BindingIdentifier) {
                const stmt = statementContaining(up as Node, parent);
                if (stmt !== null) {
                    const after = pendingAfter.get(stmt) ?? [];
                    after.push(
                        exprStmt(
                            create.CallExpression(0, 0, 0, ref(sName), [ref(boundName.name), ...signatureArgs(sig)], null),
                        ),
                    );
                    pendingAfter.set(stmt, after);
                    continue;
                }
            }

            wrapInSignature(fn, sName, signatureArgs(sig));

            // THE HOC CARRY. `memo(forwardRef(fn))` signs at every level, all with the SAME `_s` —
            // `_s(memo(_c2 = _s(forwardRef(_c = _s(fn, key)), key)), key)`. oxc keeps this in a
            // `last_signature` slot carried out of the traversal; walking up is the same thing
            // without the traversal. Assignments are stepped THROUGH, because pass 1's `_c = …`
            // wrappers sit between the function and its enclosing call.
            let cur: Node = fn;
            for (;;) {
                let up = parent.get(cur);
                while (up !== undefined && up.type === N.AssignmentExpression) {
                    cur = up;
                    up = parent.get(cur);
                }
                if (up === undefined || up.type !== N.CallExpression) break;
                // Only the ARGUMENT position carries — `fn(…)` where fn is the signed function is a
                // call OF it, not a HOC wrapping it.
                if (!(dataOf(up).arguments as Node[]).includes(cur)) break;
                wrapInSignature(up, sName, signatureArgs(sig));
                cur = up;
            }
        }
    };

    /** `_c = Foo;` — the statement that captures a component at its definition site. */
    const registrationFor = (componentName: string): Node => {
        const temp = mintRegistration();
        registrations.push([temp, componentName]);
        return exprStmt(create.AssignmentExpression(0, 0, '=', ref(temp), ref(componentName)));
    };

    /** `(_cN = expr)` in place, recording the registration. Mirrors `wrapInSignature`'s trick: the
     *  node is retyped, so nothing that points at it needs updating. */
    const wrapInRegistration: WrapFn = (inferredName, expr) => {
        const temp = mintRegistration();
        registrations.push([temp, inferredName]);
        const inner = cloneNode(expr);
        if (inner === null) return;
        const assignment = create.AssignmentExpression(expr.start, expr.end, '=', ref(temp), inner);
        set(expr, N.AssignmentExpression, assignment.data as never);
    };

    const body = dataOf(program).body as Node[];
    const out: Node[] = [];

    // PASS 1 — registration. Wrapping happens here, before any signing, because oxc does it in
    // `enter_program` and signs during the traversal that follows: `_c = fn` first, then `_s` goes
    // INSIDE it as `_c = _s(fn, key)`.
    //
    // The registration STATEMENT is minted here too, not later: `_c` numbering interleaves with the
    // inner wraps, statement by statement. `const A = forwardRef(fn)` yields `_c` for the inner
    // function and `_c2` for `A` — deferring the outer ones to the end renumbers everything.
    const registrationStatements: (Node | null)[] = [];
    for (const stmt of body) {
        const name = registerFor(stmt, jsxBindings, code, wrapInRegistration);
        registrationStatements.push(name === null ? null : registrationFor(name));
    }

    // PASS 2 — signatures, over the tree pass 1 produced.
    signatures = collectSignatures(program, code, semantic);
    signExpressions();

    for (const [i, stmt] of body.entries()) {
        out.push(stmt);
        // The signature line comes BEFORE the registration line — `_s(App, …)` then `_c = App`,
        // which is the order every fixture shows.
        const registered = registrationStatements[i];
        if (registered !== null && registered !== undefined) out.push(registered);
    }

    if (registrations.length === 0 && signatureVars.length === 0) return false;

    // A nested function's `_s` is declared inside THAT function, before anything else in it.
    for (const [scope, names] of signatureVarsByScope) {
        if (scope === null || names.length === 0) continue;
        const stmts = blockBodyOf(scope);
        if (stmts === null) continue;
        stmts.unshift(signatureDeclaration(names, refreshSig));
    }

    // `var _s = $RefreshSig$(), _s2 = $RefreshSig$();` at the top of the module.
    if (signatureVars.length > 0) out.unshift(signatureDeclaration(signatureVars, refreshSig));

    if (registrations.length === 0) {
        dataOf(program).body = out;
        applyPendingAfter(program, pendingAfter);
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
        out.push(exprStmt(create.CallExpression(0, 0, 0, refreshCallee(refreshReg), [ref(temp), str(id)], null)));
    }

    dataOf(program).body = out;
    // Last, so it can also splice into `program.body` as just rebuilt.
    applyPendingAfter(program, pendingAfter);
    return true;
}

/**
 * Which component name a TOP-LEVEL statement defines, or null. `process_statement` +
 * `handle_function_declaration` + `handle_variable_declaration` in `refresh.rs`.
 */
function registerFor(stmt: Node, jsxBindings: Set<number>, code: string, wrap: WrapFn): string | null {
    if (stmt.type === N.FunctionDeclaration) return fromFunctionDeclaration(stmt);
    if (stmt.type === N.ExportNamedDeclaration) {
        const decl = dataOf(stmt).declaration as Node | null;
        if (decl === null) return null;
        if (decl.type === N.FunctionDeclaration) return fromFunctionDeclaration(decl);
        if (decl.type === N.VariableDeclaration) return fromVariableDeclaration(decl, jsxBindings, code, wrap);
        return null;
    }
    if (stmt.type === N.ExportDefaultDeclaration) {
        const decl = dataOf(stmt).declaration as Node | null;
        if (decl === null || decl === undefined) return null;
        if (decl.type === N.FunctionDeclaration) return fromFunctionDeclaration(decl);
        // `export default memo(() => {})` — no name to register, so the inner function is wrapped
        // under the reserved id `%default%`. Only call expressions: an anonymous
        // `export default function () {}` is ignored, as oxc ignores it.
        if (decl.type === N.CallExpression) replaceInnerComponents('%default%', decl, false, code, wrap);
        return null;
    }
    if (stmt.type === N.VariableDeclaration) return fromVariableDeclaration(stmt, jsxBindings, code, wrap);
    return null;
}

function fromFunctionDeclaration(fn: Node): string | null {
    const id = dataOf(fn).id as Node | null;
    if (id === null || id === undefined) return null;
    // A `declare function` is TS-only syntax and emits nothing (`func.is_typescript_syntax()`).
    if (dataOf(fn).declare === true) return null;
    return isComponentish(id.name) ? id.name : null;
}

function fromVariableDeclaration(decl: Node, jsxBindings: Set<number>, code: string, wrap: WrapFn): string | null {
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
    const foundInside = replaceInnerComponents(id.name, init, /* isVariableDeclarator */ true, code, wrap);
    if (!foundInside && !jsxBindings.has(id.sym)) return null;
    return id.name;
}

/**
 * `replace_inner_components` — "is there a component in here?", AND wrap the ones that need it.
 *
 * A function that is not a declarator's init has no name to be registered under, so it is wrapped
 * where it stands as `(_cN = fn)`. That is how a HOC's inline argument gets registered:
 * `memo(fn)` becomes `memo(_c = fn)`. A declarator's init is left alone — it is registered by name
 * on the next line instead, so the inferred function name survives.
 *
 * `inferredName` accumulates the callee text as it descends (`Foo$memo$forwardRef`), which is the
 * persistent id an inner function is registered under.
 */
function replaceInnerComponents(
    inferredName: string,
    expr: Node,
    isVariableDeclarator: boolean,
    code: string,
    wrap: (name: string, expr: Node) => void,
): boolean {
    switch (expr.type) {
        case N.IdentifierReference:
            // `export const Something = hoc(Foo)` — `Foo` is registered at ITS definition, so this
            // reports the name's shape and wraps nothing.
            return isComponentish(expr.name);
        case N.FunctionExpression:
            break;
        case N.ArrowFunctionExpression:
            if (arrowReturnsArrow(expr)) return false;
            break;
        case N.CallExpression: {
            const callee = dataOf(expr).callee as Node;
            const calleeOk =
                callee.type === N.IdentifierReference ||
                callee.type === N.StaticMemberExpression ||
                callee.type === N.ComputedMemberExpression;
            if (!calleeOk) return false;
            const first = (dataOf(expr).arguments as Node[])[0];
            if (first === undefined) return false;
            const calleeText = code.slice(callee.start, callee.end).trim();
            if (!replaceInnerComponents(`${inferredName}$${calleeText}`, first, false, code, wrap)) return false;
            // `const Foo = hoc1(hoc2(() => {}))` — the outermost call belongs to the declarator, so
            // it is registered by name rather than wrapped.
            if (isVariableDeclarator) return true;
            break;
        }
        default:
            return false;
    }

    if (!isVariableDeclarator) wrap(inferredName, expr);
    return true;
}

/** `() => () => {}` — with `expression: true` the arrow's `body` IS the expression. */
function arrowReturnsArrow(arrow: Node): boolean {
    const d = dataOf(arrow);
    return d.expression === true && (d.body as Node).type === N.ArrowFunctionExpression;
}



/** The STATEMENT containing `n` — the ancestor that is an element of some statement list. */
function statementContaining(n: Node, parent: Map<Node, Node>): Node | null {
    let cur = n;
    for (;;) {
        const up = parent.get(cur);
        if (up === undefined) return null;
        const list = statementListOf(up);
        if (list !== null && list.includes(cur)) return cur;
        cur = up;
    }
}

/** Splice every pending next-line signature in after its statement, wherever that list lives. */
function applyPendingAfter(program: Node, pendingAfter: Map<Node, Node[]>): void {
    if (pendingAfter.size === 0) return;
    walk(program, (n) => {
        const list = statementListOf(n);
        if (list === null) return undefined;
        for (let i = list.length - 1; i >= 0; i--) {
            const extra = pendingAfter.get(list[i]);
            if (extra !== undefined) list.splice(i + 1, 0, ...extra);
        }
        return undefined;
    });
}

/** `var _s = $RefreshSig$(), _s2 = $RefreshSig$();` — one declaration, however many names. */
function signatureDeclaration(names: string[], refreshSig: string): Node {
    return create.VariableDeclaration(
        0,
        0,
        VAR_KIND.VAR,
        names.map((n) =>
            create.VariableDeclarator(0, 0, 0, binding(n), null, create.CallExpression(0, 0, 0, refreshCallee(refreshSig), [], null)),
        ),
    );
}

/**
 * Wrap `fn` in place as `_s(fn, …args)`.
 *
 * `set` retypes the node itself, so every reference to it in the tree keeps pointing at the right
 * place — no parent bookkeeping. The original contents move into a clone that becomes the call's
 * first argument. Cloning is O(function) and happens once per signed component, which is a dev-only
 * transform's budget.
 */
function wrapInSignature(fn: Node, sName: string, args: Node[]): void {
    const inner = cloneNode(fn);
    if (inner === null) return;
    const call = create.CallExpression(fn.start, fn.end, 0, ref(sName), [inner, ...args], null);
    set(fn, N.CallExpression, call.data as never);
}

/**
 * Give an arrow a BLOCK body, so `_s()` has somewhere to go.
 *
 * `() => <div/>` has an expression body; the signature call has to run before the return, so the
 * body becomes `{ return <div/>; }`. oxc does the same via
 * `arrow_function_body_as_function_body_mut`.
 */
function blockBodyOf(fn: Node): Node[] | null {
    const d = dataOf(fn);
    const body = d.body as Node | null;
    if (body === null || body === undefined) return null;
    if (d.expression !== true) return dataOf(body).body as Node[];
    const stmts: Node[] = [create.ReturnStatement(body.start, body.end, 0, body)];
    d.body = create.BlockStatement(body.start, body.end, 0, stmts);
    d.expression = false;
    return dataOf(d.body as Node).body as Node[];
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
