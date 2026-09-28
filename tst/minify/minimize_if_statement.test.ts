// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are JS source under test.
// Ported from oxc_minifier/tests/peephole/minimize_if_statement.rs by conversion: the same cases, expectations verbatim.
import { describe, it } from 'vitest';
import { test } from './harness.ts';

describe('test_minimize_if', () => {
    it('function writeInteger(int) {\n            if (int >= 0)\n     ', () =>
        test(
            'function writeInteger(int) {\n            if (int >= 0)\n                if (int <= 0xffffffff) return this.u32(int);\n                else if (int > -0x80000000) return this.n32(int);\n        }',
            'function writeInteger(int) {\n            if (int >= 0) {\n                if (int <= 4294967295) return this.u32(int);\n                if (int > -2147483648) return this.n32(int);\n            }\n        }',
        ));
    it('function bar() {\n          if (!x) {\n            return null', () =>
        test(
            'function bar() {\n          if (!x) {\n            return null;\n          } else {\n            return foo;\n          }\n        }',
            'function bar() {\n          return x ? foo : null;\n        }',
        ));
    it('function bar() {\n          if (!x) {\n            return null', () =>
        test(
            'function bar() {\n          if (!x) {\n            return null;\n          } else if (y) {\n            return foo;\n          } else if (z) {\n            return bar;\n          }\n        }',
            'function bar() {\n          if (!x) return null;\n          if (y) return foo;\n          if (z) return bar;\n        }',
        ));
    it('function f() {\n          if (foo)\n            if (bar) retur', () =>
        test(
            'function f() {\n          if (foo)\n            if (bar) return X;\n            else return Y;\n          return Z;\n        }',
            'function f() {\n          return foo ? bar ? X : Y : Z;\n        }',
        ));
    it("function _() {\n            if (currentChar === '\\n')\n       ", () =>
        test(
            "function _() {\n            if (currentChar === '\\n')\n                return pos + 1;\n            else if (currentChar !== ' ' && currentChar !== '\\t')\n                return pos + 1;\n        }",
            "function _() {\n            if (currentChar === '\\n' || currentChar !== ' ' && currentChar !== '\\t')\n                return pos + 1;\n        }",
        ));
    it('function f(){if(a)if(b)var x=1;else var y=2;return x+y}', () =>
        test(
            'function f(){if(a)if(b)var x=1;else var y=2;return x+y}',
            'function f(){if(a){if(b)var x=1;else var y=2}return x+y}',
        ));
    it('function f(){if(a)if(b)if(c)var x=1;else var y=2;return x+y}', () =>
        test(
            'function f(){if(a)if(b)if(c)var x=1;else var y=2;return x+y}',
            'function f(){if(a&&b){if(c)var x=1;else var y=2}return x+y}',
        ));
    it('function f(){if(!a){}else if(b)var x=1;else var y=2;return x', () =>
        test(
            'function f(){if(!a){}else if(b)var x=1;else var y=2;return x+y}',
            'function f(){if(a){if(b)var x=1;else var y=2}return x+y}',
        ));
});
