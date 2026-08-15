// G-JSX-3: a .tsx module wired into the exemplar graph. It imports a real
// exemplar component-ish value + enum, uses a fragment, spreads props, and
// renders a keyed list — exercising the full lower→link→shake→emit path against
// the injected `react/jsx-runtime`. Typed props exercise TS-in-JSX stripping.
import { MotionType } from './motion';
import type { Particle } from './types';

type Row = { id: number; label: string };

function Badge({ kind, ...rest }: { kind: string; [k: string]: unknown }) {
    return <span className="badge" data-kind={kind} {...rest} />;
}

export function Panel({ rows, particle }: { rows: Row[]; particle: Particle }) {
    return (
        <>
            <header className="hdr">
                <h1>Motion: {MotionType[particle.motion]}</h1>
                <Badge kind="live" title="ok" />
            </header>
            <ul className="rows">
                {rows.map((r) => (
                    <li key={r.id} data-id={r.id}>
                        {r.label}
                    </li>
                ))}
            </ul>
        </>
    );
}
