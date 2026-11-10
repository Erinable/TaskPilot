// Generates a portable shasum -a 256 -c manifest for top-level macOS packages.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { positionals } = parseArgs({ allowPositionals: true });
if (positionals.length > 1) throw new Error('Usage: node scripts/artifact_checksums.ts [directory]');
const directory = path.resolve(positionals[0] ?? 'dist');
const artifacts = (await fs.readdir(directory, { withFileTypes: true })).filter((entry) => /\.(dmg|zip)$/.test(entry.name));
if (!artifacts.length) throw new Error(`No .dmg or .zip packages found in ${directory}`);
for (const entry of artifacts) {
  const unsafeName = entry.name.includes('\\') || [...entry.name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if (!entry.isFile() || unsafeName) throw new Error(`Unsafe package file: ${JSON.stringify(entry.name)}`);
}
artifacts.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
const lines: string[] = [];
for (const entry of artifacts) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join(directory, entry.name))) hash.update(chunk);
  lines.push(`${hash.digest('hex')}  ${entry.name}`);
}
const manifest = path.join(directory, 'SHA256SUMS');
const temporary = `${manifest}.${randomUUID()}.tmp`;
try {
  await fs.writeFile(temporary, `${lines.join('\n')}\n`, { flag: 'wx' });
  await fs.rename(temporary, manifest);
} finally {
  // This unique temp path belongs to this invocation beside the manifest.
  await fs.rm(temporary, { force: true });
}
console.log(`Wrote ${artifacts.length} package checksums to ${manifest}`);
