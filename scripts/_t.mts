import { readFileSync } from 'node:fs';
import { parseWithDiagnostics } from '../src/parser/parser.ts';
for (const p of process.argv.slice(2)) {
  const src = readFileSync(p, 'utf8');
  const r = parseWithDiagnostics(src, {ts:false,jsx:false,kind:'unambiguous'});
  console.log(p.split('/').slice(-2).join('/'), '→', r.errors[0]?.msg ?? 'accepted');
}
