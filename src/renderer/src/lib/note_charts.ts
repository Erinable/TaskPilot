// Charts in notes: ```vega-lite / ```vega specs, ```mermaid diagrams and
// ```svg drawings. All of them end up as SVG built through the DOM, never
// as markup inserted into the page:
// - Vega runs with its AST interpreter (no eval) and a loader that refuses
//   every URL, so a spec can neither load outside data nor open links.
// - Mermaid and hand-written SVG go through DOMPurify, then into a shadow
//   root: <style> becomes an adopted stylesheet and style="…" is set through
//   the CSSOM, both of which the page CSP allows.
// Vega and Mermaid are large, so they load only when a note has a chart.
//
// [人工决策-2026-10-24 20:01:56] 笔记图表支持 Vega/Vega-Lite + Mermaid + SVG 代码块；不放宽 CSP，SVG 一律经 DOMPurify 清洗（不支持时拒绝渲染），动画只允许改几何/颜色属性。
import DOMPurify from 'dompurify';

export const CHART_LANGUAGES = ['vega-lite', 'vega', 'mermaid', 'svg'] as const;
export type ChartLanguage = (typeof CHART_LANGUAGES)[number];
export const isChartLanguage = (lang: string | null | undefined): lang is ChartLanguage => CHART_LANGUAGES.includes(lang as ChartLanguage);

// Larger sources are refused rather than left to freeze the page.
export const MAX_CHART_SOURCE = 256 * 1024;

// ========== SVG ==========

// SMIL animation may only move, resize and recolour; anything that could
// point somewhere (href) or run something (on…) is not animatable here.
const ANIMATION_TAGS = ['animate', 'animateTransform', 'animateMotion'];
const ANIMATABLE = new Set(
  'x y x1 y1 x2 y2 cx cy r rx ry width height d points transform opacity fill fill-opacity stroke stroke-opacity stroke-width stroke-dasharray stroke-dashoffset offset stop-color stop-opacity visibility font-size'.split(
    ' ',
  ),
);
const ANIMATION_ATTRS = [
  'attributeName',
  'attributeType',
  'values',
  'keyTimes',
  'keySplines',
  'calcMode',
  'begin',
  'end',
  'dur',
  'repeatCount',
  'repeatDur',
  'from',
  'to',
  'by',
  'additive',
  'accumulate',
  'restart',
  'type',
  'path',
  'rotate',
  'keyPoints',
];
// Renamed before parsing so no parser on the page applies an inline style;
// if one slipped past the rename, the CSP would still block it.
const STYLE_ATTR = 'data-tp-style';
const STYLE_SHEET = 'data-tp-css';

const purifier = DOMPurify(window);
// DOMPurify reports tag names in lower case (animatemotion), so they are
// compared that way; animateMotion moves along a path and names no attribute.
const LOWER_ANIMATION_TAGS = ANIMATION_TAGS.map((tag) => tag.toLowerCase());
purifier.addHook('uponSanitizeElement', (node, data) => {
  const tag = data.tagName.toLowerCase();
  if (!LOWER_ANIMATION_TAGS.includes(tag) || !(node instanceof Element)) return;
  const target = node.getAttribute('attributeName');
  if (tag !== 'animatemotion' && (!target || !ANIMATABLE.has(target.replace(/^[a-z]+:/i, '')))) node.remove();
});

export type SafeSvg = { svg: SVGSVGElement; css: string };

// A drawing as DOM, cleaned of scripts, event handlers, links, outside
// resources and foreign HTML. Fails closed when DOMPurify cannot run.
export const sanitizeSvg = (source: string): SafeSvg => {
  if (!purifier.isSupported) throw new Error('这个环境不能安全地显示 SVG');
  const defused = source
    .replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_whole, css: string) => `<desc ${STYLE_SHEET}="1">${css.replace(/</g, '&lt;')}</desc>`)
    .replace(/\sstyle\s*=\s*(["'])/gi, ` ${STYLE_ATTR}=$1`);
  // Cleaned as text first, then parsed as an SVG document, which is inert:
  // nothing in it runs, loads or is checked against the page CSP.
  const clean = purifier.sanitize(defused, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ANIMATION_TAGS,
    ADD_ATTR: [...ANIMATION_ATTRS, STYLE_ATTR, STYLE_SHEET],
    FORBID_TAGS: ['a', 'use', 'image', 'foreignObject', 'script', 'style', 'set', 'iframe'],
    FORBID_ATTR: ['style', 'href', 'xlink:href'],
  });
  const parsed = new DOMParser().parseFromString(clean, 'image/svg+xml');
  if (parsed.documentElement.nodeName !== 'svg' || parsed.querySelector('parsererror')) throw new Error('代码块里没有有效的 <svg> 元素');
  const svg = document.importNode(parsed.documentElement, true) as unknown as SVGSVGElement;
  const css = [...svg.querySelectorAll(`desc[${STYLE_SHEET}]`)]
    .map((element) => {
      element.remove();
      return element.textContent ?? '';
    })
    .join('\n');
  for (const element of svg.querySelectorAll<SVGElement>(`[${STYLE_ATTR}]`)) {
    element.style.cssText = element.getAttribute(STYLE_ATTR) ?? '';
    element.removeAttribute(STYLE_ATTR);
  }
  return { svg, css };
};

// Puts a cleaned drawing in the host's shadow root, replacing what was there.
export const mountSvg = (host: HTMLElement, { svg, css }: SafeSvg) => {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  // External loads in the CSS (url(), @import) stay subject to the page CSP.
  sheet.replaceSync(`:host { display: block; } svg { max-width: 100%; height: auto; }\n${css}`);
  root.adoptedStyleSheets = [sheet];
  root.replaceChildren(svg);
};

// ========== Theme ==========
// Charts take their colours from the page theme when they are drawn.
const themeColors = () => {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string) => style.getPropertyValue(name).trim();
  return { text: value('--text'), muted: value('--text-muted'), line: value('--line-soft'), accent: value('--accent'), font: value('--font-sans') };
};

// Validated categorical palette that reads in both light and dark themes.
const PALETTE = ['#3f6bf5', '#e8678a', '#17915b', '#d68117', '#8b5cf6', '#0ea5b7', '#64748b'];

// ========== Vega ==========

// A range slider bound to a parameter, which a play button can step through.
// label: the slider's own caption (bind.name), or the parameter name.
export type Playable = { name: string; label: string; min: number; max: number; step: number };
export type VegaHandle = {
  finalize: () => void;
  playables: Playable[];
  get: (name: string) => number;
  set: (name: string, value: number) => Promise<void>;
};

// Parameters bound to range sliders: the ones a play button can animate.
const findPlayables = (spec: Record<string, unknown>): Playable[] => {
  const lists = [spec.params, spec.signals].filter(Array.isArray) as Record<string, unknown>[][];
  return lists.flat().flatMap((entry) => {
    const bind = entry.bind as Record<string, unknown> | undefined;
    if (typeof entry.name !== 'string' || bind?.input !== 'range') return [];
    const min = Number(bind.min ?? 0);
    const max = Number(bind.max ?? 100);
    const step = Number(bind.step ?? (max - min) / 100);
    const label = typeof bind.name === 'string' && bind.name.trim() ? bind.name.trim() : entry.name;
    return Number.isFinite(min) && Number.isFinite(max) && Number.isFinite(step) && step > 0 && max > min ? [{ name: entry.name, label, min, max, step }] : [];
  });
};

const vegaConfig = () => {
  const colors = themeColors();
  return {
    background: 'transparent',
    font: colors.font,
    range: { category: PALETTE },
    axis: {
      labelColor: colors.muted,
      titleColor: colors.text,
      domainColor: colors.muted,
      tickColor: colors.muted,
      gridColor: colors.line,
      labelFontSize: 11,
      titleFontSize: 12,
    },
    legend: { labelColor: colors.muted, titleColor: colors.text, labelFontSize: 11, titleFontSize: 12 },
    title: { color: colors.text, subtitleColor: colors.muted, fontSize: 13, anchor: 'start' },
    header: { labelColor: colors.text, titleColor: colors.text },
    view: { stroke: colors.line },
    mark: { color: colors.accent },
  };
};

export const renderVega = async (host: HTMLElement, source: string, lang: 'vega' | 'vega-lite'): Promise<VegaHandle> => {
  if (source.length > MAX_CHART_SOURCE) throw new Error('图表定义太大了');
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(source);
  } catch (error) {
    throw new Error(`不是有效的 JSON：${(error as Error).message}`);
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('图表定义必须是一个 JSON 对象');
  const [vega, { expressionInterpreter }] = await Promise.all([import('vega'), import('vega-interpreter')]);
  const config = vegaConfig();
  const vegaSpec = lang === 'vega-lite' ? (await import('vega-lite')).compile(spec as never, { config: config as never }).spec : spec;
  // No URL ever loads: data, images and link clicks all go through
  // sanitize, and load/http/file refuse too in case anything bypasses it.
  // Vega only warns when a load fails, so a refusal is remembered and the
  // chart fails instead of drawing empty.
  const loader = vega.loader();
  let refused: string | null = null;
  const refuse = async (uri: unknown): Promise<never> => {
    refused = `笔记里的图表不能加载外部数据或打开链接（${String(uri).slice(0, 80)}），请把数据写在 values 里`;
    throw new Error(refused);
  };
  Object.assign(loader, { sanitize: refuse, load: refuse, http: refuse, file: refuse });
  const runtime = vega.parse(vegaSpec as never, lang === 'vega' ? (config as never) : undefined, { ast: true });
  const view = new vega.View(runtime, { expr: expressionInterpreter, renderer: 'svg', container: host, hover: true, loader, logLevel: vega.Warn });
  await view.runAsync();
  if (refused) {
    view.finalize();
    throw new Error(refused);
  }
  return {
    finalize: () => view.finalize(),
    playables: findPlayables(spec),
    get: (name) => Number(view.signal(name)),
    set: async (name, value) => {
      await view.signal(name, value).runAsync();
    },
  };
};

// ========== Mermaid ==========

let mermaidCount = 0;

export const renderMermaid = async (source: string): Promise<SafeSvg> => {
  if (source.length > MAX_CHART_SOURCE) throw new Error('图太大了');
  const { default: mermaid } = await import('mermaid');
  const colors = themeColors();
  // SVG text labels (no HTML in foreignObject), strict security, theme colours.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    theme: 'base',
    fontFamily: colors.font,
    themeVariables: {
      primaryColor: 'transparent',
      primaryTextColor: colors.text,
      primaryBorderColor: colors.accent,
      lineColor: colors.muted,
      textColor: colors.text,
      fontSize: '13px',
    },
  });
  mermaidCount += 1;
  const { svg } = await mermaid.render(`note-mermaid-${mermaidCount}`, source);
  return sanitizeSvg(svg);
};
