/**
 * The `/@react-refresh` module the dev server serves, as source text.
 *
 * Neither oxc nor rolldown contains this layer — rolldown's wrapper only names the functions. It is
 * `@vitejs/plugin-react` JavaScript over Meta's `react-refresh/runtime`, and the implementation
 * below is adapted from `@parcel/transformer-react-refresh-wrap`'s `helpers.js`, which says at the
 * top that it is itself adapted from facebook/metro (MIT). Same primitives, same algorithms; the
 * signatures are vite's, because the wrapper text this pairs with is vite's.
 *
 * `react-refresh/runtime` is resolved against the USER's app, not shakeup — shakeup has no React
 * dependency and must not acquire one.
 */
export const REACT_REFRESH_RUNTIME_ID = '/@react-refresh';

export const REACT_REFRESH_RUNTIME_SOURCE = `import * as Refresh from 'react-refresh/runtime';

// Call immediately when the last call was more than \`delay\` ago, otherwise coalesce — so a single
// edit refreshes at once and a burst is batched. metro's shape, via parcel.
function debounce(fn, delay) {
  let timeout;
  let lastTime = 0;
  return function () {
    const now = Date.now();
    if (now - lastTime > delay) {
      lastTime = now;
      fn();
      return;
    }
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeout = undefined;
      lastTime = Date.now();
      fn();
    }, delay);
  };
}

const enqueueUpdate = debounce(() => Refresh.performReactRefresh(), 30);

export const register = Refresh.register;
export const createSignatureFunctionForTransform = Refresh.createSignatureFunctionForTransform;

// Re-exported unchanged. The no-op \`$RefreshReg$\`/\`$RefreshSig$\` globals are NOT set here — they
// belong to the preamble a host injects before any app code (see REACT_REFRESH_PREAMBLE), which is
// where vite puts them.
export const injectIntoGlobalHook = Refresh.injectIntoGlobalHook;

/**
 * Whether these exports are an ES module namespace, and so safe to read.
 *
 * parcel asks only \`'__esModule' in exports\`, because it runs over CommonJS-shaped modules where a
 * transpiled ESM module carries that marker and a getter without it is a CJS getter that may have
 * side effects. That test is WRONG for a real ESM namespace, whose live bindings are getters and
 * which has no \`__esModule\`: every module would read as unsafe, no module would ever be a refresh
 * boundary, and Fast Refresh would silently do nothing. \`Symbol.toStringTag\` is the standard answer
 * — a genuine namespace has it, and so does the namespace shakeup's module runner builds (as does
 * vite's).
 */
function isESM(exports) {
  return '__esModule' in exports || exports[Symbol.toStringTag] === 'Module';
}

/** A module is a boundary if it exports components AND NOTHING ELSE — one non-component export and
 *  an edit has to propagate to importers instead. */
function isReactRefreshBoundary(exports) {
  if (Refresh.isLikelyComponentType(exports)) return true;
  if (exports === null || typeof exports !== 'object') return false;
  let hasExports = false;
  let areAllExportsComponents = true;
  for (const key in exports) {
    hasExports = true;
    if (key === '__esModule') continue;
    // A getter on a CommonJS namespace may have side effects, so it is never invoked to find out.
    const desc = Object.getOwnPropertyDescriptor(exports, key);
    if (desc && desc.get && !isESM(exports)) return false;
    if (!Refresh.isLikelyComponentType(exports[key])) areAllExportsComponents = false;
  }
  return hasExports && areAllExportsComponents;
}

/** The identity of every exported component, as a flat list. When this changes across an edit the
 *  boundary cannot be trusted — an export was added, removed, or changed kind. */
function getRefreshBoundarySignature(exports) {
  const signature = [Refresh.getFamilyByType(exports)];
  if (exports === null || typeof exports !== 'object') return signature;
  for (const key in exports) {
    if (key === '__esModule') continue;
    const desc = Object.getOwnPropertyDescriptor(exports, key);
    if (desc && desc.get && !isESM(exports)) continue;
    signature.push(key);
    signature.push(Refresh.getFamilyByType(exports[key]));
  }
  return signature;
}

/** Give every export a stable family id, so the runtime can match an old component to its new
 *  version. \`%exports%\` is metro's marker for the namespace itself. */
export function registerExportsForReactRefresh(id, exports) {
  Refresh.register(exports, id + ' %exports%');
  if (exports === null || typeof exports !== 'object') return;
  for (const key in exports) {
    const desc = Object.getOwnPropertyDescriptor(exports, key);
    if (desc && desc.get && !isESM(exports)) continue;
    Refresh.register(exports[key], id + ' %exports% ' + key);
  }
}

/**
 * Decide whether this module can absorb its own update. Returns a REASON to invalidate, or nothing
 * to accept — vite's shape. (parcel's equivalent returns the parent modules instead; the difference
 * is which side walks the graph, and here the caller is \`import.meta.hot.invalidate\`.)
 */
export function validateRefreshBoundaryAndEnqueueUpdate(id, prevExports, nextExports) {
  const ineligible = !isReactRefreshBoundary(nextExports);
  if (ineligible) return 'Could not Fast Refresh (export removed or no longer a component)';

  const prevSignature = getRefreshBoundarySignature(prevExports);
  const nextSignature = getRefreshBoundarySignature(nextExports);
  if (prevSignature.length !== nextSignature.length) {
    return 'Could not Fast Refresh (exports changed)';
  }
  for (let i = 0; i < nextSignature.length; i++) {
    if (prevSignature[i] !== nextSignature[i]) {
      return 'Could not Fast Refresh (' + String(nextSignature[i - 1]) + ' changed)';
    }
  }
  enqueueUpdate();
  return undefined;
}
`;

/**
 * What a host must run BEFORE any app code, as an ES module.
 *
 * Without it `window.$RefreshReg$` is missing and the footer throws — deliberately, so a misconfigured
 * host fails loudly instead of silently not refreshing.
 *
 * UNVERIFIED against vite: `@vitejs/plugin-react` is not vendored here, so unlike the footer (which is
 * transcribed from rolldown's `add_refresh_wrapper`) this text has no oracle. It uses a NAMESPACE
 * import because that is what {@link REACT_REFRESH_RUNTIME_SOURCE} actually exports and what the footer
 * already does. vite additionally sets a `__vite_plugin_react_preamble_installed__` flag, which only its
 * own error message reads; the footer transcribed from rolldown checks `window.$RefreshReg$`, so the
 * flag would be dead here and is left out.
 */
export function reactRefreshPreamble(host = ''): string {
    return `import * as RefreshRuntime from ${JSON.stringify(`${host}${REACT_REFRESH_RUNTIME_ID}`)};
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
`;
}
