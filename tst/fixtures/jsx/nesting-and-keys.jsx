// Deep nesting, keyed lists, spread-then-normal-attr ordering, mixed children.
export function Table({ rows, columns }) {
    return (
        <table className="grid">
            <thead>
                <tr>
                    {columns.map((col) => (
                        <th key={col.key} scope="col" style={col.style}>
                            {col.label}
                        </th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {rows.map((row, rowIndex) => (
                    <tr key={row.id} className={rowIndex % 2 ? 'odd' : 'even'}>
                        {columns.map((col) => (
                            <td key={col.key} {...col.cellProps} title={row[col.key]}>
                                {col.render ? col.render(row) : row[col.key]}
                            </td>
                        ))}
                    </tr>
                ))}
            </tbody>
            <tfoot>
                <tr>
                    <td colSpan={columns.length}>Total: {rows.length} rows</td>
                </tr>
            </tfoot>
        </table>
    );
}

export const Nested = () => (
    <div className="a">
        <div className="b">
            <div className="c">
                <div className="d">
                    <span>{deep}</span>
                </div>
            </div>
        </div>
    </div>
);
