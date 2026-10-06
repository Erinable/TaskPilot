// Avatar text and colours, derived on the client too so previews follow typing.
export const AVATAR_COLOR_NAMES = ['sunset', 'ocean', 'violet', 'forest', 'graphite'] as const;

export type AvatarColor = (typeof AVATAR_COLOR_NAMES)[number];

export const initialsOf = (name: string | null | undefined) => {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '';
  const words = trimmed.split(/[\s._-]+/).filter(Boolean);
  const first = [...words[0]][0];
  if (/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(first)) return first;
  const last = words.length > 1 ? [...words[words.length - 1]][0] : '';
  return (first + last).toUpperCase();
};

export const avatarColorOf = (color: string | null | undefined): AvatarColor => (AVATAR_COLOR_NAMES as readonly string[]).includes(color ?? '') ? color as AvatarColor : 'sunset';
