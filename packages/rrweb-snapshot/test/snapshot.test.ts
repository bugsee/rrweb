/**
 * @vitest-environment jsdom
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import snapshot, {
  _isBlockedElement,
  needMaskingText,
  serializeNodeWithId,
  transformAttribute,
} from '../src/snapshot';
import { elementNode, serializedNodeWithId } from '../src/types';
import type { serializedElementNodeWithId } from '@rrweb/types';
import { Mirror, absolutifyURLs } from '../src/utils';

const serializeNode = (node: Node): serializedNodeWithId | null => {
  return serializeNodeWithId(node, {
    doc: document,
    mirror: new Mirror(),
    blockClass: 'blockblock',
    blockSelector: null,
    maskTextClass: 'maskmask',
    maskTextSelector: null,
    skipChild: false,
    inlineStylesheet: true,
    maskTextFn: undefined,
    maskInputFn: undefined,
    slimDOMOptions: {},
  });
};

describe('absolute url to stylesheet', () => {
  const href = 'http://localhost/css/style.css';

  it('can handle relative path', () => {
    expect(absolutifyURLs('url(a.jpg)', href)).toEqual(
      `url(http://localhost/css/a.jpg)`,
    );
  });

  it('can handle same level path', () => {
    expect(absolutifyURLs('url("./a.jpg")', href)).toEqual(
      `url("http://localhost/css/a.jpg")`,
    );
  });

  it('can handle parent level path', () => {
    expect(absolutifyURLs('url("../a.jpg")', href)).toEqual(
      `url("http://localhost/a.jpg")`,
    );
  });

  it('can handle hashes', () => {
    expect(absolutifyURLs('url("../a.jpg#c/d")', href + '#e/f')).toEqual(
      `url("http://localhost/a.jpg#c/d")`,
    );
  });

  it('can handle absolute path', () => {
    expect(absolutifyURLs('url("/a.jpg")', href)).toEqual(
      `url("http://localhost/a.jpg")`,
    );
  });

  it('can handle external path', () => {
    expect(absolutifyURLs('url("http://localhost/a.jpg")', href)).toEqual(
      `url("http://localhost/a.jpg")`,
    );
  });

  it('can handle single quote path', () => {
    expect(absolutifyURLs(`url('./a.jpg')`, href)).toEqual(
      `url('http://localhost/css/a.jpg')`,
    );
  });

  it('can handle no quote path', () => {
    expect(absolutifyURLs('url(./a.jpg)', href)).toEqual(
      `url(http://localhost/css/a.jpg)`,
    );
  });

  it('can handle multiple no quote paths', () => {
    expect(
      absolutifyURLs(
        'background-image: url(images/b.jpg);background: #aabbcc url(images/a.jpg) 50% 50% repeat;',
        href,
      ),
    ).toEqual(
      `background-image: url(http://localhost/css/images/b.jpg);` +
        `background: #aabbcc url(http://localhost/css/images/a.jpg) 50% 50% repeat;`,
    );
  });

  it('can handle data url image', () => {
    expect(absolutifyURLs('url(data:image/gif;base64,ABC)', href)).toEqual(
      'url(data:image/gif;base64,ABC)',
    );
    expect(
      absolutifyURLs(
        'url(data:application/font-woff;base64,d09GMgABAAAAAAm)',
        href,
      ),
    ).toEqual('url(data:application/font-woff;base64,d09GMgABAAAAAAm)');
  });

  it('preserves quotes around inline svgs with spaces', () => {
    expect(
      absolutifyURLs(
        "url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cpath fill='%2328a745' d='M3'/%3E%3C/svg%3E\")",
        href,
      ),
    ).toEqual(
      "url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cpath fill='%2328a745' d='M3'/%3E%3C/svg%3E\")",
    );
    expect(
      absolutifyURLs(
        'url(\'data:image/svg+xml;utf8,<svg width="28" height="32" viewBox="0 0 28 32" xmlns="http://www.w3.org/2000/svg"><path d="M27 14C28" fill="white"/></svg>\')',
        href,
      ),
    ).toEqual(
      'url(\'data:image/svg+xml;utf8,<svg width="28" height="32" viewBox="0 0 28 32" xmlns="http://www.w3.org/2000/svg"><path d="M27 14C28" fill="white"/></svg>\')',
    );
    expect(
      absolutifyURLs(
        'url("data:image/svg+xml;utf8,<svg width="28" height="32" viewBox="0 0 28 32" xmlns="http://www.w3.org/2000/svg"><path d="M27 14C28" fill="white"/></svg>")',
        href,
      ),
    ).toEqual(
      'url("data:image/svg+xml;utf8,<svg width="28" height="32" viewBox="0 0 28 32" xmlns="http://www.w3.org/2000/svg"><path d="M27 14C28" fill="white"/></svg>")',
    );
  });
  it('can handle empty path', () => {
    expect(absolutifyURLs(`url('')`, href)).toEqual(`url('')`);
  });
});

describe('isBlockedElement()', () => {
  const subject = (html: string, opt: any = {}) =>
    _isBlockedElement(render(html), 'rr-block', opt.blockSelector);

  const render = (html: string): HTMLElement =>
    JSDOM.fragment(html).querySelector('div')!;

  it('can handle empty elements', () => {
    expect(subject('<div />')).toEqual(false);
  });

  it('blocks prohibited className', () => {
    expect(subject('<div class="foo rr-block bar" />')).toEqual(true);
  });

  it('does not block random data selector', () => {
    expect(subject('<div data-rr-block />')).toEqual(false);
  });

  it('blocks blocked selector', () => {
    expect(
      subject('<div data-rr-block />', { blockSelector: '[data-rr-block]' }),
    ).toEqual(true);
  });

  it('unblock wins: an element matching unblockSelector is not blocked (overrides block class)', () => {
    expect(
      _isBlockedElement(
        render('<div class="rr-block bugsee-show" />'),
        'rr-block',
        null,
        '.bugsee-show',
      ),
    ).toBe(false);
  });

  it('still blocks when unblockSelector does not match', () => {
    expect(
      _isBlockedElement(render('<div class="rr-block" />'), 'rr-block', null, '.bugsee-show'),
    ).toBe(true);
  });
});

describe('style elements', () => {
  const render = (html: string): HTMLStyleElement => {
    document.write(html);
    return document.querySelector('style')!;
  };

  it('should serialize all rules of stylesheet when the sheet has a single child node', () => {
    const styleEl = render(`<style>body { color: red; }</style>`);
    styleEl.sheet?.insertRule('section { color: blue; }');
    expect(serializeNode(styleEl)).toMatchObject({
      rootId: undefined,
      attributes: {
        _cssText: 'section {color: blue;}body {color: red;}',
      },
      type: 2,
    });
  });

  it('should serialize all rules on stylesheets with mix of insertion type', () => {
    const styleEl = render(`<style>body { color: red; }</style>`);
    styleEl.sheet?.insertRule('section.lost { color: unseeable; }'); // browser throws this away after append
    styleEl.append(document.createTextNode('section { color: blue; }'));
    styleEl.sheet?.insertRule('section.working { color: pink; }');
    expect(serializeNode(styleEl)).toMatchObject({
      rootId: undefined,
      attributes: {
        _cssText:
          'section.working {color: pink;}body {color: red;}/* rr_split */section {color: blue;}',
      },
      type: 2,
    });
  });
});

describe('scrollTop/scrollLeft', () => {
  const render = (html: string): HTMLDivElement => {
    document.write(html);
    return document.querySelector('div')!;
  };

  it('should serialize scroll positions', () => {
    const el = render(`<div stylel='overflow: auto; width: 1px; height: 1px;'>
      Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.
    </div>`);
    el.scrollTop = 10;
    el.scrollLeft = 20;
    expect(serializeNode(el)).toMatchObject({
      attributes: {
        rr_scrollTop: 10,
        rr_scrollLeft: 20,
      },
    });
  });
});

describe('form', () => {
  const render = (html: string): HTMLTextAreaElement => {
    document.write(html);
    return document.querySelector('textarea')!;
  };

  it('should record textarea values once', () => {
    const el = render(`<textarea>Lorem ipsum</textarea>`);
    const sel = serializeNode(el) as elementNode;

    // we serialize according to where the DOM stores the value, not how
    // the HTML stores it (this is so that maskInputValue can work over
    // inputs/textareas/selects in a uniform way)
    expect(sel).toMatchObject({
      attributes: {
        value: 'Lorem ipsum',
      },
    });
    expect(sel?.childNodes).toEqual([]); // shouldn't be stored in childNodes while in transit
  });
});

describe('jsdom snapshot', () => {
  const render = (html: string): Document => {
    document.write(html);
    return document;
  };

  it("doesn't rely on global browser objects", () => {
    // this test is incomplete in terms of coverage,
    // but the idea being that we are checking that all features use the
    // passed-in `doc` object rather than the global `document`
    // (which is only present in browsers)
    // in any case, supporting jsdom is not a primary goal

    const doc = render(`<!DOCTYPE html><p>Hello world</p><canvas></canvas>`);
    const sn = snapshot(doc, {
      // JSDOM Error: Not implemented: HTMLCanvasElement.prototype.toDataURL (without installing the canvas npm package)
      //recordCanvas: true,
    });
    expect(sn).toMatchObject({
      type: 0,
    });
  });
});

describe('needMaskingText — maskAllText + selective unmask (nearest-ancestor-wins)', () => {
  // Build a DOM tree and return the deepest leaf element, so we can test the mask/unmask decision
  // from the perspective of a text node's containing element.
  function leaf(html: string): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.appendChild(root);
    let el: Element = root;
    while (el.firstElementChild) el = el.firstElementChild;
    return el as HTMLElement;
  }
  const call = (
    el: Node,
    opts: {
      maskClass?: string;
      maskSel?: string | null;
      unmaskClass?: string | null;
      unmaskSel?: string | null;
      maskAll?: boolean;
    } = {},
  ) =>
    needMaskingText(
      el,
      opts.maskClass ?? 'rr-mask',
      opts.maskSel ?? null,
      opts.unmaskClass ?? null,
      opts.unmaskSel ?? null,
      opts.maskAll ?? false,
    );

  it('maskAllText=true masks a plain element with no unmask ancestor', () => {
    expect(call(leaf('<p>hi</p>'), { maskAll: true })).toBe(true);
  });

  it('maskAllText=true is overridden by an unmask ancestor (selector)', () => {
    expect(
      call(leaf('<div class="ok"><p>hi</p></div>'), { maskAll: true, unmaskSel: '.ok' }),
    ).toBe(false);
  });

  it('maskAllText=false does NOT mask when nothing matches', () => {
    expect(call(leaf('<p>hi</p>'), { maskAll: false })).toBe(false);
  });

  it('maskAllText=false masks when a mask selector matches', () => {
    expect(call(leaf('<div class="secret"><p>hi</p></div>'), { maskSel: '.secret' })).toBe(true);
  });

  it('nearest ancestor wins: mask nearer than unmask → masked', () => {
    // unmask is the outer ancestor, mask is nearer → masked
    const el = leaf('<div class="unmask"><div class="mask"><p>hi</p></div></div>');
    expect(call(el, { maskSel: '.mask', unmaskSel: '.unmask', maskAll: true })).toBe(true);
  });

  it('nearest ancestor wins: unmask nearer than mask → unmasked', () => {
    const el = leaf('<div class="mask"><div class="unmask"><p>hi</p></div></div>');
    expect(call(el, { maskSel: '.mask', unmaskSel: '.unmask', maskAll: true })).toBe(false);
  });

  it('honours a mask class (not just selector)', () => {
    expect(call(leaf('<div class="rr-mask"><p>hi</p></div>'), { maskClass: 'rr-mask' })).toBe(true);
  });
});

describe('attribute-value masking', () => {
  const asterisk = (_name: string, value: string) => '*'.repeat(value.length);

  describe('transformAttribute', () => {
    it('applies maskAttributeFn to a plain attribute value', () => {
      const el = document.createElement('input');
      expect(
        transformAttribute(document, 'input', 'placeholder', 'you@host.com', el, asterisk),
      ).toBe('************');
    });

    it('passes (name, value, element) through to maskAttributeFn', () => {
      const el = document.createElement('div');
      const seen: Array<[string, string, Element]> = [];
      transformAttribute(
        document,
        'div',
        'title',
        'secret',
        el,
        (name, value, element) => {
          seen.push([name, value, element]);
          return 'X';
        },
      );
      expect(seen).toEqual([['title', 'secret', el]]);
    });

    it('does NOT mask URL/style attributes — the special-cases take precedence', () => {
      const el = document.createElement('img');
      // src is absolutified, never handed to maskAttributeFn
      expect(
        transformAttribute(document, 'img', 'src', '/a/b.png', el, asterisk),
      ).not.toContain('*');
    });

    it('leaves the value unchanged when no maskAttributeFn is given (regression)', () => {
      const el = document.createElement('div');
      expect(
        transformAttribute(document, 'div', 'title', 'hello', el, undefined),
      ).toBe('hello');
    });
  });

  it('threads maskAttributeFn through serializeNodeWithId → serialized attributes are masked', () => {
    const el = document.createElement('input');
    el.setAttribute('placeholder', 'you@host.com');
    el.setAttribute('aria-label', 'Email address');
    const sn = serializeNodeWithId(el, {
      doc: document,
      mirror: new Mirror(),
      blockClass: 'blockblock',
      blockSelector: null,
      maskTextClass: 'maskmask',
      maskTextSelector: null,
      skipChild: false,
      inlineStylesheet: true,
      maskTextFn: undefined,
      maskInputFn: undefined,
      maskAttributeFn: asterisk,
      slimDOMOptions: {},
    }) as serializedElementNodeWithId;
    expect(sn.attributes.placeholder).toBe('************');
    expect(sn.attributes['aria-label']).toBe('*************');
  });
});
