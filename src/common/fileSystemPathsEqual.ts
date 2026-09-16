/**
 * Equality for file-system paths coming from different producers (an
 * opened document uri vs. a watcher event uri). On case-insensitive
 * file systems the same file can be reported with different casing, so
 * the caller passes whether the target file system folds case.
 */
export function fileSystemPathsEqual(a: string, b: string, caseInsensitive: boolean): boolean {
    if (caseInsensitive) {
        return a.toLowerCase() === b.toLowerCase();
    }
    return a === b;
}
