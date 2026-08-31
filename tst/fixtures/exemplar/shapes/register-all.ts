// SIDE-EFFECT MODULE (crashcat register-all): importing this mutates the shared
// registry Map. The entry imports it for effect only (`import './register-all.ts'`)
// and the observable result — registry.size === 2 — proves it ran exactly once.

import { def as box } from './box.ts';
import { def as circle } from './circle.ts';
import { register } from './registry.ts';

register(circle);
register(box);
