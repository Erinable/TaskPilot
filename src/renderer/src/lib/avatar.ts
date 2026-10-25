// Avatar text and colours, derived on the client too so previews follow typing.
import * as avatar from '@shared/avatar.ts';

export const AVATAR_COLOR_NAMES = avatar.AVATAR_COLORS;

export type AvatarColor = avatar.AvatarColor;

export const initialsOf = avatar.initialsOf;

export const avatarColorOf = (color: string | null | undefined): AvatarColor =>
  (AVATAR_COLOR_NAMES as readonly string[]).includes(color ?? '') ? (color as AvatarColor) : 'sunset';
