// Run after npm run build: node scripts/analyze_renderer.ts.
// Uses the actual emitted ES modules. SVG geometry is mocked, so Mermaid
// results describe dependency loading only, never browser rendering speed.
import fs from 'node:fs/promises';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Window } from 'happy-dom';

const root = process.cwd();
const assets = path.join(root, 'out/renderer/assets');
const names = await fs.readdir(assets);
const sources = new Map(
  await Promise.all(names.filter((name) => name.endsWith('.js')).map(async (name) => [name, await fs.readFile(path.join(assets, name), 'utf8')] as const)),
);
const asset = (prefix: string) => {
  const name = names.find((name) => name.startsWith(`${prefix}-`) && name.endsWith('.js'));
  if (!name) throw new Error(`Build is missing ${prefix}: run npm run build first`);
  return name;
};
const closure = (entries: string[]) => {
  const visited = new Set<string>();
  const visit = (name: string) => {
    if (visited.has(name)) return;
    visited.add(name);
    for (const [, dependency] of (sources.get(name) ?? '').matchAll(/^import[^\n;]*?["']\.\/([^"']+\.js)["'];/gm)) visit(dependency);
  };
  entries.forEach(visit);
  return [...visited].sort();
};
const summarize = async (files: string[]) => ({
  files,
  bytes: (await Promise.all(files.map(async (name) => (await fs.stat(path.join(assets, name))).size))).reduce((sum, size) => sum + size, 0),
});
const preloadCss = (entry: string, target: string) => {
  const source = sources.get(entry) ?? '';
  const map = source.match(/m\.f=\[(.*?)\]\)\)\)=>/);
  if (!map) return [];
  const dependencies: string[] = JSON.parse(`[${map[1]}]`);
  const calls = [...source.matchAll(/__vitePreload\(\(\) => import\("\.\/([^"]+)"\)[^\n]*?__vite__mapDeps\(\[([^\]]*)\]\)/g)];
  const call = calls.find(([, name]) => name === target);
  return call
    ? call[2]
        .split(',')
        .map((index) => dependencies[Number(index)].replace(/^\.\//, ''))
        .filter((name) => name.endsWith('.css'))
    : [];
};
const entry = asset('index');
const mount = asset('mount_app');
const settings = asset('SettingsView');
const profile = asset('ProfilePage');
const html = await fs.readFile(path.join(root, 'out/renderer/index.html'), 'utf8');
const entryCss = [...html.matchAll(/href="\.\/assets\/([^"]+\.css)"/g)].map(([, name]) => name);
const startupJs = closure([entry, mount]);
const startupCss = [...new Set([...entryCss, ...preloadCss(entry, mount)])].sort();
const settingsJs = closure([settings]).filter((name) => !startupJs.includes(name));
const profileJs = closure([profile]).filter((name) => !startupJs.includes(name) && !settingsJs.includes(name));
const settingsCss = preloadCss(mount, settings).filter((name) => !startupCss.includes(name));
const profileCss = preloadCss(settings, profile).filter((name) => !startupCss.includes(name) && !settingsCss.includes(name));
const bundle = {
  startup: { js: await summarize(startupJs), css: await summarize(startupCss) },
  settings: { js: await summarize(settingsJs), css: await summarize(settingsCss) },
  profile: { js: await summarize(profileJs), css: await summarize(profileCss) },
};
const mastery = asset('mastery_model');
const graphExport = sources.get(mastery)?.match(/conceptGraph as (\w+)/)?.[1];
if (!graphExport) throw new Error('The built mastery model has no conceptGraph export');
const masteryModule = await import(pathToFileURL(path.join(assets, mastery)).href);
const masteryGraph: string = masteryModule[graphExport](
  [
    { id: 'a', label: 'Concept A', prerequisites: [], state: 'new' },
    { id: 'b', label: 'Concept B', prerequisites: ['a'], state: 'learning' },
  ],
  'b',
);

const window = new Window({
  url: pathToFileURL(path.join(root, 'out/renderer/index.html')).href,
  settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true, handleDisabledFileLoadingAsSuccess: true },
});
// Suppress unrelated app startup in the shared entry, without rewriting any
// emitted module: its splash's frame callback and ready promise stay pending.
Object.defineProperty(window, 'taskpilot', { value: { app: { ready: () => new Promise(() => {}) } } });
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'SVGElement',
  'Element',
  'Node',
  'DOMParser',
  'XMLSerializer',
  'Event',
  'CustomEvent',
  'MutationObserver',
  'CSSStyleSheet',
] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? window : window[key] });
Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: window.getComputedStyle.bind(window) });
// The shared startup entry schedules one animation frame to import the app.
// Keep that first frame pending; chart work can use later frames normally.
let frames = 0;
Object.defineProperty(globalThis, 'requestAnimationFrame', {
  configurable: true,
  value: (callback: (at: number) => void) => {
    frames += 1;
    if (frames > 1) queueMicrotask(() => callback(0));
    return frames;
  },
});
// Vite's preload helper awaits stylesheet load events. No resource fetching is
// needed in this dependency probe; complete these links after listeners attach.
const append = window.document.head.appendChild.bind(window.document.head);
Object.defineProperty(window.document.head, 'appendChild', {
  value: (node: Parameters<typeof append>[0]) => {
    const result = append(node);
    if (node.nodeName === 'LINK') queueMicrotask(() => node.dispatchEvent(new window.Event('load')));
    return result;
  },
});
Object.defineProperty(window.SVGElement.prototype, 'getBBox', {
  configurable: true,
  value: () => ({ x: 0, y: 0, width: 100, height: 20 }),
});
Object.defineProperty(window.SVGElement.prototype, 'getComputedTextLength', { configurable: true, value: () => 100 });

let phase = 'import';
const loaded = new Map<string, string[]>();
const hooks = registerHooks({
  load: (url, context, next) => {
    const result = next(url, context);
    if (url.startsWith(pathToFileURL(assets + path.sep).href)) {
      const files = loaded.get(phase) ?? [];
      files.push(path.basename(fileURLToPath(url)));
      loaded.set(phase, files);
    }
    return result;
  },
});
// Use separate processes for two cold comparisons. Later phases in each run
// deliberately share the module cache and therefore measure incremental loads.
const defaultFirst = process.argv.includes('--default-first');
const defaultGraph = masteryGraph.replace(/^---\n[\s\S]*?\n---\n/, '');
// Dagre is an analysis-only candidate. The product keeps its original layout.
const dagreCandidate = `---\nconfig:\n  layout: dagre\n---\n${defaultGraph}`;
const graphScenarios = defaultFirst
  ? [
      ['mastery-original-layout', masteryGraph],
      ['candidate-dagre-flowchart', dagreCandidate],
    ]
  : [
      ['candidate-dagre-flowchart', dagreCandidate],
      ['mastery-original-layout', masteryGraph],
    ];
const results: { name: string; outcome: string; loaded: string[]; bytes: number; elk: boolean; cytoscape: boolean }[] = [];
try {
  const { default: mermaid } = await import(pathToFileURL(path.join(assets, asset('mermaid.core'))).href);
  const record = async (name: string, outcome: string) => {
    const files = [...new Set(loaded.get(name) ?? [])].sort();
    const { bytes } = await summarize(files);
    results.push({
      name,
      outcome,
      loaded: files,
      bytes,
      elk: files.some((file) => file.startsWith('elk-')),
      cytoscape: files.some((file) => file.startsWith('cytoscape.')),
    });
  };
  await record('import', 'loaded');
  for (const [name, source] of [
    ...graphScenarios,
    ['explicit-elk', '---\nconfig:\n  layout: elk\n---\nflowchart LR\n A --> B'],
    ['mindmap', 'mindmap\n root((Root))\n  A\n  B'],
  ]) {
    phase = name;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false }, theme: 'base' });
    let outcome = 'rendered-with-mocked-geometry';
    try {
      await mermaid.render(`bundle-probe-${name}`, source);
    } catch (error) {
      outcome = `render-error: ${error instanceof Error ? error.message : String(error)}`;
    }
    await record(name, outcome);
  }
} finally {
  hooks.deregister();
  await window.happyDOM.close();
}
const output = path.join(root, '.taskpilot/analysis/renderer', defaultFirst ? 'renderer-default-first-report.json' : 'renderer-report.json');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(
  output,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), bundle, mermaid: { method: 'Node module load hooks + happy-dom with mocked SVG geometry; no browser timing or screenshots', results } }, null, 2)}\n`,
);
console.log(JSON.stringify({ bundle, mermaid: results.map(({ loaded: _loaded, ...result }) => result), output }, null, 2));
