import { parseSync } from 'oxc-parser';
import { parseWithDiagnostics } from '../src/parser/parser.ts';
for (const src of [
  'var g = function*() { (function yield() {}); };',
  'function* g() { function yield() {} }',
  'function* g() { (function yield() {}); }',
  'async function f() { (function await() {}); }',
  'var await;',
  'var await;\nasync function foo() { function bar() { await = 1; } bar(); }',
  'async function foo() { function bar() { await = 1; } }',
  'function bar() { await = 1; }',
  'await = 1;',
  'var await, b;',
]) {
  const o = (() => { try { return parseSync('t.js', src, {sourceType:'script'}).errors.length===0 } catch { return false } })();
  const r = parseWithDiagnostics(src, {ts:false,jsx:false,kind:'unambiguous'});
  const s = r.errors.length===0;
  console.log(`${o===s?'ok  ':'DIFF'} oxc=${o?'A':'R'} sk=${s?'A':'R'}  ${JSON.stringify(src).slice(0,58).padEnd(60)} ${r.errors[0]?.msg ?? ''}`);
}
