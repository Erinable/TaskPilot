// Semantic versions: the form a release version must have, for Release
// Manager's arithmetic and for the versions presets read from manifests.

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

// {major, minor, patch, prerelease} of a semver string, or null when it is
// not one (or a part is too large to add to exactly).
export const parseVersion = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const match = SEMVER.exec(value.trim());
  if (!match) return null;
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number);
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part + 1))) return null;
  return { major, minor, patch, prerelease: match[4] ?? null };
};

// `value` trimmed when it is a semver string, else null.
export const semverOrNull = (value: unknown) => (typeof value === 'string' && parseVersion(value) ? value.trim() : null);

// Orders release versions (major, minor, patch; a prerelease before its
// release). Unparsable versions sort first.
export const compareVersions = (left: string | null, right: string | null): number => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || (a.prerelease ? (b.prerelease ? 0 : -1) : b.prerelease ? 1 : 0);
};
