// The OS lab fixture repository (./os_lab/): four small C programs that use
// system calls directly (pipe and fork, open/read/write, threads and locks,
// a bounded buffer), built and checked by `make grade`, which the
// repository's taskpilot.toml runs as its `custom:grade` step. It needs only
// cc and make, no RISC-V toolchain or xv6.
import fs from 'node:fs';
import path from 'node:path';

const OS_LAB_DIR = path.join(import.meta.dirname, 'os_lab');

const filesUnder = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [path.relative(OS_LAB_DIR, full).split(path.sep).join('/')];
  });

// Path -> contents, sorted by path.
export const OS_LAB: Record<string, string> = Object.fromEntries(
  filesUnder(OS_LAB_DIR)
    .sort()
    .map((file) => [file, fs.readFileSync(path.join(OS_LAB_DIR, file), 'utf8')]),
);

// The reference solution for each lab program (../tutor-grade/os_reference/).
const REFERENCE_DIR = path.join(import.meta.dirname, '..', 'tutor-grade', 'os_reference');
export const osReference = (file: string): string => fs.readFileSync(path.join(REFERENCE_DIR, file), 'utf8');
