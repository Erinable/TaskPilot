// The toolchains a course lab is built with. A lab repository names one in
// taskpilot.toml (`toolchain`); TaskPilot writes its tests/build.mk from it
// (buildRules), checks its tools under the self-check's sandbox before a lab
// is generated, and passes only that toolchain's variables to the sandbox
// (src/main/courses/lab_toolchain.ts). The learner picks one on the goal form;
// a course pack lists the ones it is written for (appliesTo.toolchains).

export const LAB_TOOLCHAINS = ['c', 'rust', 'python'] as const;
export type LabToolchainId = (typeof LAB_TOOLCHAINS)[number];

export const isLabToolchain = (value: unknown): value is LabToolchainId => typeof value === 'string' && (LAB_TOOLCHAINS as readonly string[]).includes(value);

export const TOOLCHAIN_LABELS: Record<LabToolchainId, string> = {
  c: 'C（cc + make）',
  rust: 'Rust（rustc + make）',
  python: 'Python 3（python3 + make）',
};

// A tool the toolchain needs on the command PATH, how to print its version,
// and how the learner installs it (shown, never run).
export type LabTool = { command: string; versionArgs: string[]; install: string };

const MAKE: LabTool = { command: 'make', versionArgs: ['--version'], install: 'xcode-select --install   # 或 sudo apt install make' };
const RUSTUP = "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # 或从 https://rustup.rs 安装";

// What each toolchain is: the language the generator writes, a source's
// extension, whether a program is one entry file, the tools it needs, and the
// build line the generator is told about.
export const TOOLCHAINS: Record<LabToolchainId, { language: string; extension: string; singleSource: boolean; tools: LabTool[]; buildLine: string }> = {
  c: {
    language: 'C (C11)',
    extension: '.c',
    singleSource: false,
    tools: [{ command: 'cc', versionArgs: ['--version'], install: 'xcode-select --install   # 或 sudo apt install build-essential' }, MAKE],
    buildLine:
      '`cc -std=c11 -Wall -O1 -g -Isrc -o build/<program> <sources> -lm`: every source is a .c file, headers under src/ are found with #include "<name>.h".',
  },
  rust: {
    language: 'Rust (2021 edition, standard library only, no Cargo and no crates)',
    extension: '.rs',
    singleSource: true,
    tools: [{ command: 'rustc', versionArgs: ['--version'], install: RUSTUP }, MAKE],
    buildLine: '`rustc --edition 2021 -o build/<program> <entry>`: the entry is the crate root with fn main; other .rs files beside it are its `mod`s.',
  },
  python: {
    language: 'Python 3 (standard library only)',
    extension: '.py',
    singleSource: true,
    tools: [{ command: 'python3', versionArgs: ['--version'], install: 'brew install python   # 或从 https://www.python.org/downloads/ 安装' }, MAKE],
    buildLine: 'build/<program> is a launcher that runs `python3 -B <entry>`: the entry is the main script; modules beside it are imported by name.',
  },
};

// One program `make build` makes: build/<program> from `sources` (paths in
// the repository). A Rust or Python program has one source, its entry.
export type LabProgram = { program: string; sources: string[] };

export const PROGRAM_NAME = /^[a-z][a-z0-9-]{0,31}$/;

// The toolchain a goal form's environment text from before toolchains names,
// or null when it names none or more than one.
export const inferToolchain = (environment: string): LabToolchainId | null => {
  const text = environment.toLowerCase();
  const found = LAB_TOOLCHAINS.filter((toolchain) => (toolchain === 'c' ? /(^|[^a-z+#])c(?![a-z+#])|gcc|clang|xv6/.test(text) : text.includes(toolchain)));
  return found.length === 1 ? found[0] : null;
};

const recipe = (toolchain: LabToolchainId, { program, sources }: LabProgram): string[] => {
  const target = `build/${program}`;
  if (toolchain === 'c') return [`\tcc -std=c11 -Wall -O1 -g -Isrc -o ${target} ${sources.join(' ')} -lm`];
  if (toolchain === 'rust') return [`\trustc --edition 2021 --crate-name ${program.replaceAll('-', '_')} -o ${target} ${sources[0]}`];
  if (toolchain !== 'python') throw new Error(`Unknown lab toolchain: ${String(toolchain)}`);
  return [
    `\tpython3 -B -c 'import ast, sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])' ${sources[0]}`,
    `\tprintf '%s\\n' '#!/bin/sh' 'exec python3 -B "$$(dirname "$$0")/../${sources[0]}" "$$@"' > ${target}`,
    `\tchmod +x ${target}`,
  ];
};

// tests/build.mk for a lab repository: one always-rebuilt target per
// program, in stage order, and `clean`. Paths are checked plain names
// (src/…, no spaces), so nothing is quoted.
export const buildRules = (toolchain: LabToolchainId, programs: LabProgram[]): string => {
  const targets = programs.map(({ program }) => `build/${program}`).join(' ');
  return [
    `# Written by TaskPilot from the lab toolchain (${toolchain}); TaskPilot rewrites it`,
    '# when it adds a lab. `make build` makes every stage’s program under build/.',
    `build: ${targets}`,
    '',
    ...programs.flatMap((entry) => [`build/${entry.program}:`, '\t@mkdir -p build', ...recipe(toolchain, entry), '']),
    'clean:',
    '\trm -rf build',
    '',
    `.PHONY: build clean ${targets}`,
    '',
  ].join('\n');
};
