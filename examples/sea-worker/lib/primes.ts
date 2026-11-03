// Shared by both threads: the main thread splits the range with it, and each
// worker counts its share with it. A worker importing this proves that a
// worker's own relative imports resolve inside the archive too, not only its
// script.

/** Split `[2, limit]` into `parts` contiguous ranges of about equal size. */
export function split(limit: number, parts: number): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    const size = Math.ceil((limit - 1) / parts);
    for (let from = 2; from <= limit; from += size) ranges.push([from, Math.min(limit, from + size - 1)]);
    return ranges;
}

/** How many primes lie in `[from, to]`, by trial division: slow on purpose, so there is work to share. */
export function count(from: number, to: number): number {
    let found = 0;
    for (let n = Math.max(2, from); n <= to; n++) {
        let prime = true;
        for (let d = 2; d * d <= n; d++) {
            if (n % d === 0) { prime = false; break; }
        }
        if (prime) found++;
    }
    return found;
}
