// TSX module: JSX + TypeScript. Exercises the tsx generic-arrow ambiguity, the
// generic component tag typeArguments, typed props, and type-annotated children.
// (Meriyah can't represent this — parser-only fixture; parsed with ts+jsx.)
import type { ReactNode } from 'react';
import { useState } from 'react';

type Props<T> = { items: T[]; render: (item: T) => ReactNode; empty?: ReactNode };

// generic arrow (NOT JSX) — the canonical tsx disambiguation with trailing comma
const identity = <T,>(x: T): T => x;
const first = <T extends { id: number }>(xs: T[]): T | undefined => xs[0];

export function List<T>({ items, render, empty }: Props<T>) {
    const [selected, setSelected] = useState<T | null>(null);
    if (items.length === 0) return <>{empty ?? <span className="empty">No items</span>}</>;
    return (
        <ul className="list">
            {items.map((item, i) => (
                <li key={i} onClick={() => setSelected(item)}>
                    {render(item)}
                </li>
            ))}
            <li data-selected={selected !== null}>selection marker</li>
        </ul>
    );
}

// generic component tag <Comp<T> /> — type_arguments on the opening element
const numbers = <List<number> items={[1, 2, 3]} render={(n) => <b>{n}</b>} />;

export function Panel({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="panel">
            <h2>{title}</h2>
            <div className="body">{children}</div>
        </section>
    );
}

export { identity, first, numbers };
