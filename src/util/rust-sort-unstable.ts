// Rust's `slice::sort_unstable_by` (ipnsort, `core/src/slice/sort/unstable/`), ported so that a port of
// Rust code that sorts with ties lands the tied elements where Rust does. The oxc mangler ranks slots
// with `sort_unstable_by_key(|x| Reverse(x.frequency))`, and which of two equally hot slots gets the
// shorter name decides the output text.
//
// Only the paths an element type larger than 16 bytes takes: the cyclic branchless Lomuto partition
// with no unrolling, and a stable small-sort (`small_sort_general` and `insertion_sort_shift_left`
// are both stable, so any stable sort reproduces them).

const MAX_LEN_ALWAYS_INSERTION_SORT = 20;
const PSEUDO_MEDIAN_REC_THRESHOLD = 64;

type IsLess<T> = (a: T, b: T) => boolean;

/**
 * `sort_unstable_by`. `smallSortThreshold` is `T::small_sort_threshold()`: 32 for a `Freeze` type of at
 * most 85 bytes (`SMALL_SORT_GENERAL_THRESHOLD`), 16 otherwise.
 */
export function sortUnstableBy<T>(v: T[], isLess: IsLess<T>, smallSortThreshold: number): void {
    const len = v.length;
    if (len < 2) return;
    if (len <= MAX_LEN_ALWAYS_INSERTION_SORT) {
        insertionSort(v, 0, len, isLess);
        return;
    }
    ipnsort(v, isLess, smallSortThreshold);
}

function ipnsort<T>(v: T[], isLess: IsLess<T>, smallSortThreshold: number): void {
    const len = v.length;
    const [runLen, wasReversed] = findExistingRun(v, isLess);
    if (runLen === len) {
        if (wasReversed) v.reverse();
        return;
    }
    const limit = 2 * Math.floor(Math.log2(len | 1));
    quicksort(v, 0, len, null, limit, isLess, smallSortThreshold);
}

function findExistingRun<T>(v: T[], isLess: IsLess<T>): [number, boolean] {
    const len = v.length;
    if (len < 2) return [len, false];
    let runLen = 2;
    const strictlyDescending = isLess(v[1], v[0]);
    if (strictlyDescending) {
        while (runLen < len && isLess(v[runLen], v[runLen - 1])) runLen++;
    } else {
        while (runLen < len && !isLess(v[runLen], v[runLen - 1])) runLen++;
    }
    return [runLen, strictlyDescending];
}

/** Sorts `v[start..end]`. `ancestorPivot` is the pivot of the partition this range is the right side of. */
function quicksort<T>(
    v: T[],
    start: number,
    end: number,
    ancestorPivot: { value: T } | null,
    limit: number,
    isLess: IsLess<T>,
    smallSortThreshold: number,
): void {
    for (;;) {
        const len = end - start;
        if (len <= smallSortThreshold) {
            insertionSort(v, start, end, isLess);
            return;
        }
        if (limit === 0) {
            heapsort(v, start, end, isLess);
            return;
        }
        limit--;
        const pivotPos = choosePivot(v, start, len, isLess);
        if (ancestorPivot !== null && !isLess(ancestorPivot.value, v[start + pivotPos])) {
            const numLt = partition(v, start, end, pivotPos, (a, b) => !isLess(b, a));
            start += numLt + 1;
            ancestorPivot = null;
            continue;
        }
        const numLt = partition(v, start, end, pivotPos, isLess);
        const pivot = { value: v[start + numLt] };
        quicksort(v, start, start + numLt, ancestorPivot, limit, isLess, smallSortThreshold);
        start += numLt + 1;
        ancestorPivot = pivot;
    }
}

function partition<T>(v: T[], start: number, end: number, pivot: number, isLess: IsLess<T>): number {
    const len = end - start;
    if (len === 0) return 0;
    swap(v, start, start + pivot);
    const numLt = partitionLomutoBranchlessCyclic(v, start + 1, end, v[start], isLess);
    swap(v, start, start + numLt);
    return numLt;
}

/** `partition_lomuto_branchless_cyclic` with `unroll_len == 1`. `gapValue` stands in for the value the
 *  Rust holds outside the slice; `right === -1` reads it. */
function partitionLomutoBranchlessCyclic<T>(v: T[], start: number, end: number, pivot: T, isLess: IsLess<T>): number {
    const len = end - start;
    if (len === 0) return 0;
    const gapValue = v[start];
    let numLt = 0;
    let right = start + 1;
    let gapPos = start;
    const loopBody = (): void => {
        const rightValue = right === -1 ? gapValue : v[right];
        const rightIsLt = isLess(rightValue, pivot);
        const left = start + numLt;
        v[gapPos] = v[left];
        v[left] = rightValue;
        gapPos = right;
        numLt += rightIsLt ? 1 : 0;
        if (right !== -1) right++;
    };
    while (right < end) loopBody();
    // The cleanup iteration: the saved first element takes the last turn and fills the gap.
    right = -1;
    loopBody();
    return numLt;
}

function choosePivot<T>(v: T[], start: number, len: number, isLess: IsLess<T>): number {
    const lenDiv8 = Math.floor(len / 8);
    const a = start;
    const b = start + lenDiv8 * 4;
    const c = start + lenDiv8 * 7;
    if (len < PSEUDO_MEDIAN_REC_THRESHOLD) return median3(v, a, b, c, isLess) - start;
    return median3Rec(v, a, b, c, lenDiv8, isLess) - start;
}

function median3Rec<T>(v: T[], a: number, b: number, c: number, n: number, isLess: IsLess<T>): number {
    if (n * 8 >= PSEUDO_MEDIAN_REC_THRESHOLD) {
        const n8 = Math.floor(n / 8);
        a = median3Rec(v, a, a + n8 * 4, a + n8 * 7, n8, isLess);
        b = median3Rec(v, b, b + n8 * 4, b + n8 * 7, n8, isLess);
        c = median3Rec(v, c, c + n8 * 4, c + n8 * 7, n8, isLess);
    }
    return median3(v, a, b, c, isLess);
}

function median3<T>(v: T[], a: number, b: number, c: number, isLess: IsLess<T>): number {
    const x = isLess(v[a], v[b]);
    const y = isLess(v[a], v[c]);
    if (x === y) {
        const z = isLess(v[b], v[c]);
        return z !== x ? c : b;
    }
    return a;
}

function heapsort<T>(v: T[], start: number, end: number, isLess: IsLess<T>): void {
    const len = end - start;
    for (let i = len + Math.floor(len / 2) - 1; i >= 0; i--) {
        let siftIdx: number;
        if (i >= len) siftIdx = i - len;
        else {
            swap(v, start, start + i);
            siftIdx = 0;
        }
        siftDown(v, start, Math.min(i, len), siftIdx, isLess);
    }
}

function siftDown<T>(v: T[], start: number, len: number, node: number, isLess: IsLess<T>): void {
    for (;;) {
        let child = 2 * node + 1;
        if (child >= len) break;
        if (child + 1 < len && isLess(v[start + child], v[start + child + 1])) child++;
        if (!isLess(v[start + node], v[start + child])) break;
        swap(v, start + node, start + child);
        node = child;
    }
}

function insertionSort<T>(v: T[], start: number, end: number, isLess: IsLess<T>): void {
    for (let tail = start + 1; tail < end; tail++) {
        const value = v[tail];
        let hole = tail;
        while (hole > start && isLess(value, v[hole - 1])) {
            v[hole] = v[hole - 1];
            hole--;
        }
        v[hole] = value;
    }
}

function swap<T>(v: T[], i: number, j: number): void {
    const t = v[i];
    v[i] = v[j];
    v[j] = t;
}
