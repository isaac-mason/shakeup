// The ONE class in the exemplar (a spawner). TS modifiers: private + readonly
// fields, an optional method. Exported and instantiated by the entry.
import type { Vec2 } from './math/vec2';
import { create as vec } from './math/vec2';

export class Emitter {
    // readonly + private fields with TS modifiers
    private readonly origin: Vec2;
    private count: number;

    // destructuring with defaults in params
    constructor({ x = 0, y = 0 }: { x?: number; y?: number } = {}) {
        this.origin = vec(x, y);
        this.count = 0;
    }

    // spawn returns a particle position offset by the running count
    spawn(): Vec2 {
        this.count += 1;
        return vec(this.origin.x + this.count, this.origin.y);
    }

    // optional method (declared with `?`) — must strip cleanly and still run
    total?(): number {
        return this.count;
    }
}
