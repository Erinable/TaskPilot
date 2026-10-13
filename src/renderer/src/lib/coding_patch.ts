// Cuts a git patch into one diff per file, in the order the main process
// lists the patch's files (it parses them from the same `diff --git` headers).
export const splitPatch = (patch: string): string[] => patch.split(/(?=^diff --git )/m).filter((segment) => segment.startsWith('diff --git '));
