// SIDE-EFFECT MODULE (crashcat register-all): importing this mutates the shared
// registry Map. The entry imports it for effect only (`import './register-all'`)
// and the observable result — registry.size === 2 — proves it ran exactly once.

import { def as box } from './box';
import { def as circle } from './circle';
import { register } from './registry';

register(circle);
register(box);
