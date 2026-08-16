type EnumerationOf<T extends readonly string[], Acc = unknown, Len extends readonly unknown[] = [unknown]> = T extends readonly [
    infer H extends string,
    ...infer R extends readonly string[],
]
    ? EnumerationOf<R, Acc & Record<H, Len['length']>, [...Len, unknown]>
    : { readonly [K in keyof Acc]: Acc[K] };

export function enumeration<const T extends readonly string[]>(...keys: T): EnumerationOf<T> {
    const o: Record<string, number> = {};
    for (let i = 0; i < keys.length; i++) o[keys[i]] = i + 1;
    return Object.freeze(o) as EnumerationOf<T>;
}
