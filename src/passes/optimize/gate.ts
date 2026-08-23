// Per-function opt-in gate — port of compilecat `passes/gate.rs`.
//
// The optimizer tier may only MUTATE code inside opted-in constructs; everything else must come out
// byte-identical. Passes still RECURSE everywhere (an opted-in function can be nested inside one that
// is not), and guard each mutation on `active`.
//
// The two enter methods differ deliberately:
//   • `enterFn`    — functions are independent units, so `active` RESETS to whether this function is
//                    itself opted in. A nested un-annotated function inside an annotated one is NOT
//                    optimized.
//   • `enterScope` — a block/loop INHERITS: once inside an opted-in construct the whole subtree stays
//                    active, and a directive-attached block (`/* @optimize */ { … }`) turns it on.
export class Gate {
    private readonly touched: ReadonlySet<number> | null;
    /** Whether the current position is inside an opted-in construct (always true when ungated). */
    active: boolean;

    private constructor(touched: ReadonlySet<number> | null, active: boolean) {
        this.touched = touched;
        this.active = active;
    }

    /** Whole-program behaviour — every construct is optimizable (used by per-pass harnesses). */
    static ungated(): Gate {
        return new Gate(null, true);
    }

    /** Restrict mutation to `touched` span starts. */
    static gated(touched: ReadonlySet<number>): Gate {
        return new Gate(touched, false);
    }

    /** Enter a function/arrow boundary. Returns the prior `active` for {@link exit}. */
    enterFn(start: number): boolean {
        const saved = this.active;
        if (this.touched !== null) this.active = this.touched.has(start);
        return saved;
    }

    /** Enter a block/loop/statement scope — inherits, or turns on if itself directive-attached. */
    enterScope(start: number): boolean {
        const saved = this.active;
        if (this.touched !== null) this.active = this.active || this.touched.has(start);
        return saved;
    }

    exit(saved: boolean): void {
        this.active = saved;
    }
}
