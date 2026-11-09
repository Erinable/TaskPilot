import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

type Color = [number, number, number, number];

const css = readFileSync(new URL('../../../src/renderer/src/assets/tokens.css', import.meta.url), 'utf8');
const [lightCss, darkCss] = css.split('@media (prefers-color-scheme: dark)');
const declarations = (source: string) => Object.fromEntries([...source.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]]));
const light = declarations(lightCss);
const themes = { light, dark: { ...light, ...declarations(darkCss) } };
const resolve = (value: string, tokens: Record<string, string>): string =>
  value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => resolve(tokens[name], tokens));
const color = (value: string): Color => {
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
    return [Number.parseInt(full.slice(0, 2), 16), Number.parseInt(full.slice(2, 4), 16), Number.parseInt(full.slice(4, 6), 16), 1];
  }
  const values = value.match(/[\d.]+/g)!.map(Number);
  return [values[0], values[1], values[2], values[3] ?? 1];
};
const over = (foreground: Color, background: Color): Color =>
  [...foreground.slice(0, 3).map((channel, index) => channel * foreground[3] + background[index] * (1 - foreground[3])), 1] as Color;
const luminance = (value: Color) =>
  value
    .slice(0, 3)
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (foreground: Color, background: Color) => {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
};

for (const [theme, tokens] of Object.entries(themes)) {
  describe(`${theme} theme text contrast`, () => {
    const token = (name: string) => color(resolve(tokens[name], tokens));
    const canvas = token('--canvas');
    const surfaces = [
      canvas,
      ...[canvas, ...['--orb-a', '--orb-b', '--orb-c'].map((orb) => over(token(orb), canvas))].flatMap((backdrop) => {
        const panel = over(token('--glass-bg'), backdrop);
        const strongPanel = over(token('--glass-bg-strong'), backdrop);
        return [panel, strongPanel, over(token('--fill'), panel), over(token('--fill-hover'), strongPanel)];
      }),
    ];

    test('small body, helper and placeholder text remains readable on app surfaces', () => {
      for (const foreground of ['--text', '--text-secondary', '--text-muted', '--text-tertiary']) {
        for (const background of surfaces) expect(contrast(token(foreground), background), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    test('small semantic text including unavailable warnings remains readable on its tinted surface', () => {
      for (const semantic of ['accent', 'success', 'warning', 'danger']) {
        for (const surface of surfaces) {
          const background = over(token(`--${semantic}-soft`), surface);
          expect(contrast(token(`--${semantic}`), background), semantic).toBeGreaterThanOrEqual(4.5);
          if (semantic === 'accent') expect(contrast(token('--accent-strong'), background)).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    test('white button text meets contrast throughout primary and danger gradients including hover', () => {
      for (const gradient of ['--accent-gradient', '--danger-gradient']) {
        const endpoints = resolve(tokens[gradient], tokens)
          .match(/#[a-f\d]{6}/gi)!
          .map(color);
        for (let step = 0; step <= 20; step += 1) {
          const position = step / 20;
          const background = endpoints[0].map((channel, index) => channel + (endpoints[1][index] - channel) * position) as Color;
          const hover = background.map((channel, index) => (index === 3 ? channel : Math.min(255, channel * 1.06))) as Color;
          expect(contrast(token('--text-on-color'), background), gradient).toBeGreaterThanOrEqual(4.5);
          expect(contrast(token('--text-on-color'), hover), `${gradient} hover`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(token('--text-on-color'), token('--accent-fill'))).toBeGreaterThanOrEqual(4.5);
    });
  });
}
