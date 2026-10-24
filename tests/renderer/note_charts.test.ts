// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';

import { isChartLanguage, mountSvg, renderVega, sanitizeSvg } from '../../src/renderer/src/lib/note_charts.ts';

const HOSTILE = [
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">',
  '<script>alert(2)</script>',
  '<a href="javascript:alert(3)"><text>link</text></a>',
  '<use href="#x"/>',
  '<image href="https://evil.example/x.png"/>',
  '<foreignObject><iframe src="https://evil.example"></iframe></foreignObject>',
  '<circle r="5" onclick="alert(4)" style="fill: red"/>',
  '<rect width="1"><animate attributeName="width" from="0" to="10" dur="1s"/><animate attributeName="href" to="javascript:alert(5)"/></rect>',
  '<set attributeName="onclick" to="alert(6)"/>',
  '<style>.x { fill: blue; }</style>',
  '</svg>',
].join('');

describe('note charts', () => {
  test('chart code blocks are recognised by language', () => {
    expect(['vega-lite', 'vega', 'mermaid', 'svg'].every(isChartLanguage)).toBe(true);
    expect(isChartLanguage('ts')).toBe(false);
    expect(isChartLanguage(null)).toBe(false);
  });

  test('SVG loses scripts, handlers, links, outside resources and dangerous animation; styles move to the CSSOM', () => {
    const { svg, css } = sanitizeSvg(HOSTILE);
    const markup = svg.outerHTML;
    for (const banned of ['<script', 'onload', 'onclick', '<a ', '<a>', '<use', '<image', 'foreignObject', 'iframe', 'javascript:', '<set', '<style'])
      expect(markup, banned).not.toContain(banned);
    expect(svg.querySelectorAll('animate')).toHaveLength(1);
    expect(svg.querySelector('animate')?.getAttribute('attributeName')).toBe('width');
    expect(svg.querySelector('circle')?.style.fill).toBe('red');
    expect(css).toContain('.x { fill: blue; }');
  });

  test('motion along a path and attribute animation survive cleaning', () => {
    const { svg } = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><circle r="9"><animateMotion dur="4s" repeatCount="indefinite" path="M0,0 L10,10"/></circle><rect><animateTransform attributeName="transform" type="rotate" from="0" to="90" dur="1s"/></rect></svg>',
    );
    expect(svg.querySelector('animateMotion')?.getAttribute('path')).toBe('M0,0 L10,10');
    expect(svg.querySelector('animateTransform')?.getAttribute('type')).toBe('rotate');
  });

  test('a cleaned drawing goes into a shadow root with its stylesheet', () => {
    const host = document.createElement('div');
    mountSvg(host, sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:green}</style><rect width="2" height="2"/></svg>'));
    expect(host.children).toHaveLength(0);
    expect(host.shadowRoot?.querySelector('rect')).not.toBeNull();
    expect(host.shadowRoot?.adoptedStyleSheets[0].cssRules.length).toBeGreaterThan(0);
  });

  test('a block without an <svg> element is refused', () => {
    expect(() => sanitizeSvg('<p>not a drawing</p>')).toThrow('<svg>');
  });

  test('range sliders become play controls, labelled by the slider caption', async () => {
    const spec = {
      data: { values: [{ x: 1 }] },
      params: [
        { name: 'frame', value: 0, bind: { input: 'range', min: 0, max: 8, step: 1, name: '训练帧 ' } },
        { name: 'pick', value: 'a', bind: { input: 'select', options: ['a'] } },
      ],
      mark: 'point',
      encoding: { x: { field: 'x', type: 'quantitative' } },
    };
    const view = await renderVega(document.createElement('div'), JSON.stringify(spec), 'vega-lite');
    expect(view.playables).toEqual([{ name: 'frame', label: '训练帧', min: 0, max: 8, step: 1 }]);
    await view.set('frame', 3);
    expect(view.get('frame')).toBe(3);
    view.finalize();
  });

  test('Vega specs must be JSON objects, and never load a URL', async () => {
    const host = document.createElement('div');
    await expect(renderVega(host, '{oops', 'vega-lite')).rejects.toThrow('JSON');
    await expect(renderVega(host, '[1]', 'vega-lite')).rejects.toThrow('JSON 对象');
    await expect(renderVega(host, JSON.stringify({ data: { url: 'https://evil.example/data.json' }, mark: 'point' }), 'vega-lite')).rejects.toThrow(/外部数据/);
  });
});
