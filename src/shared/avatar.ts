export const AVATAR_COLORS = ['sunset', 'ocean', 'violet', 'forest', 'graphite'] as const;

export type AvatarColor = (typeof AVATAR_COLORS)[number];

export const initialsOf = (name: string | null | undefined): string => {
  const words = (name ?? '')
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (!words.length) return '';
  const first = [...words[0]][0];
  if (/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(first)) return first;
  const last = words.length > 1 ? [...words[words.length - 1]][0] : '';
  return (first + last).toUpperCase();
};
