// The shape of parsed JSON from outside the process (files on disk, a
// hand-edited config) before it is checked field by field. Reading through
// it is allowed; every value must still be checked before use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseJson = Record<string, any>;
