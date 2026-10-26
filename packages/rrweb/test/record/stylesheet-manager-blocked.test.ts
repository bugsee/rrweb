/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { StylesheetManager } from '../../src/record/stylesheet-manager';

// A <link> stylesheet that finishes loading in a document of a blocked iframe is not recorded (its inlined css text
// is page content). The adopted-style-sheet gate lives next to the manager (record/index.ts) and is covered by the
// real-browser tests.

const link = () => {
  const el = document.createElement('link');
  el.rel = 'stylesheet';
  document.head.appendChild(el);
  return el;
};
const childSn = {
  id: 5,
  type: 2,
  tagName: 'link',
  attributes: { _cssText: 'p{content:"SECRET"}' },
  childNodes: [],
} as never;

describe('StylesheetManager.attachLinkElement and blocked documents', () => {
  it('reports the inlined css of a link in a document that is not blocked (control)', () => {
    const mutationCb = vi.fn();
    const m = new StylesheetManager({
      mutationCb,
      adoptedStyleSheetCb: vi.fn(),
      isDocBlocked: () => false,
    });
    m.attachLinkElement(link(), childSn);
    expect(mutationCb).toHaveBeenCalledTimes(1);
  });

  it('reports it by default when no gate is given', () => {
    const mutationCb = vi.fn();
    const m = new StylesheetManager({
      mutationCb,
      adoptedStyleSheetCb: vi.fn(),
    });
    m.attachLinkElement(link(), childSn);
    expect(mutationCb).toHaveBeenCalledTimes(1);
  });

  it('drops it, and does not track the link, in a blocked document; asks about the link own document', () => {
    const mutationCb = vi.fn();
    const asked: Document[] = [];
    const m = new StylesheetManager({
      mutationCb,
      adoptedStyleSheetCb: vi.fn(),
      isDocBlocked: (d) => {
        asked.push(d);
        return true;
      },
    });
    const el = link();
    m.attachLinkElement(el, childSn);
    expect(mutationCb).not.toHaveBeenCalled();
    expect(asked).toEqual([el.ownerDocument]);
    expect(
      (
        m as unknown as { trackedLinkElements: WeakSet<object> }
      ).trackedLinkElements.has(el),
    ).toBe(false);
  });
});
