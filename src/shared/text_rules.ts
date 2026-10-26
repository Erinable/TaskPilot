// Characters refused in agent output and user text: C0 controls except tab
// and line breaks, DEL, and bidirectional overrides that can disguise text.
// The ranges are the point of the pattern, hence the lint exception.
// eslint-disable-next-line no-control-regex
export const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;

// As CONTROL_CHARS, and also carriage returns (single-line notes and
// checklist text).
// eslint-disable-next-line no-control-regex
export const CONTROL_CHARS_NO_CR = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/;
