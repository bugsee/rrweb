/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { createMirror, type serializedNodeWithId } from 'rrweb-snapshot';
import { IframeManager } from '../../src/record/iframe-manager';
import { isIframeBlocked } from '../../src/utils';

// Unit level: the IframeManager is the last line of defence below the snapshot. Each guard is checked on its own
// (the integration tests in blocked-iframe.test.ts can't tell a guard from the one next to it).

const setup = (blocked: (el: HTMLIFrameElement) => boolean) => {
  const mutationCb = vi.fn();
  const wrappedEmit = vi.fn();
  const mirror = createMirror();
  const manager = new IframeManager({
    mirror,
    mutationCb,
    wrappedEmit,
    stylesheetManager: {
      styleMirror: { generateId: () => 1 },
      adoptStyleSheets: vi.fn(),
    } as never,
    recordCrossOriginIframes: true,
    isIframeBlocked: blocked,
  });
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  const loadListener = vi.fn();
  const unloadListener = vi.fn();
  manager.addLoadListener(loadListener);
  manager.addUnloadListener(unloadListener);
  const childSn = {
    id: 5,
    type: 0,
    childNodes: [],
  } as unknown as serializedNodeWithId;
  const message = () =>
    new MessageEvent('message', {
      data: {
        type: 'rrweb',
        origin: window.location.origin,
        event: { type: 3, timestamp: 1, data: { source: 5, id: 1 } },
      },
      origin: window.location.origin,
      source: iframe.contentWindow,
    });
  return {
    manager,
    iframe,
    mutationCb,
    wrappedEmit,
    loadListener,
    unloadListener,
    childSn,
    message,
    destroy: () => {
      manager.destroy();
      document.body.innerHTML = '';
    },
  };
};

describe('IframeManager with a blocked iframe', () => {
  it('addIframe does not register a blocked iframe for cross-origin message routing', () => {
    const t = setup(() => true);
    t.manager.addIframe(t.iframe);
    expect(
      (
        t.manager as unknown as {
          crossOriginIframeMap: WeakMap<object, unknown>;
        }
      ).crossOriginIframeMap.has(t.iframe.contentWindow!),
    ).toBe(false);
    t.destroy();
  });

  it('addIframe registers an iframe that is not blocked (control)', () => {
    const t = setup(() => false);
    t.manager.addIframe(t.iframe);
    expect(
      (
        t.manager as unknown as {
          crossOriginIframeMap: WeakMap<object, unknown>;
        }
      ).crossOriginIframeMap.has(t.iframe.contentWindow!),
    ).toBe(true);
    t.destroy();
  });

  it('attachIframe emits nothing and starts no observation for a blocked iframe', () => {
    const t = setup(() => true);
    t.manager.attachIframe(t.iframe, t.childSn);
    expect(t.mutationCb).not.toHaveBeenCalled();
    expect(t.loadListener).not.toHaveBeenCalled();
    t.destroy();
  });

  it('attachIframe attaches an iframe that is not blocked (control)', () => {
    const t = setup(() => false);
    t.manager.attachIframe(t.iframe, t.childSn);
    expect(t.mutationCb).toHaveBeenCalledTimes(1);
    expect(t.loadListener).toHaveBeenCalledWith(t.iframe);
    t.destroy();
  });

  it('drops a cross-origin message from a blocked iframe, accepts it otherwise', () => {
    let blocked = false;
    const t = setup(() => blocked);
    t.manager.addIframe(t.iframe);
    window.dispatchEvent(t.message());
    expect(t.wrappedEmit).toHaveBeenCalledTimes(1);
    blocked = true;
    window.dispatchEvent(t.message());
    expect(t.wrappedEmit).toHaveBeenCalledTimes(1);
    t.destroy();
  });

  it('isBlocked follows the chain of iframes the element is nested in', () => {
    const blockedIds = new Set<string>();
    const t = setup((el) => blockedIds.has(el.id));
    t.iframe.id = 'outer';
    const inner = t.iframe.contentDocument!.createElement('iframe');
    inner.id = 'inner';
    t.iframe.contentDocument!.body.appendChild(inner);
    t.manager.attachIframe(t.iframe, t.childSn);
    expect(t.manager.isBlocked(inner)).toBe(false);
    blockedIds.add('outer');
    expect(t.manager.isBlocked(inner)).toBe(true);
    t.destroy();
  });

  it('isDocBlocked releases the recording of a blocked iframe once, and keeps its document gated', () => {
    let blocked = false;
    const t = setup(() => blocked);
    t.manager.addIframe(t.iframe);
    t.manager.attachIframe(t.iframe, t.childSn);
    const doc = t.iframe.contentDocument!;
    expect(t.manager.isDocBlocked(doc)).toBe(false);
    expect(t.unloadListener).not.toHaveBeenCalled();

    blocked = true;
    expect(t.manager.isDocBlocked(doc)).toBe(true);
    expect(t.unloadListener).toHaveBeenCalledTimes(1);
    expect(t.unloadListener).toHaveBeenCalledWith(doc);
    // message routing and window listeners are gone
    expect(
      (
        t.manager as unknown as {
          crossOriginIframeMap: WeakMap<object, unknown>;
        }
      ).crossOriginIframeMap.has(t.iframe.contentWindow!),
    ).toBe(false);
    expect(
      (t.manager as unknown as { attachedWindows: Map<object, unknown> })
        .attachedWindows.size,
    ).toBe(0);

    // unblocked again: still gated (released), and not released twice
    blocked = false;
    expect(t.manager.isDocBlocked(doc)).toBe(true);
    expect(t.unloadListener).toHaveBeenCalledTimes(1);

    // a new attach (full snapshot) opens the gate again
    t.manager.attachIframe(t.iframe, t.childSn);
    expect(t.manager.isDocBlocked(doc)).toBe(false);
    t.destroy();
  });

  it('never gates a document it does not own (the top document)', () => {
    const t = setup(() => true);
    expect(t.manager.isDocBlocked(document)).toBe(false);
    t.destroy();
  });
});

describe('IframeManager: block state of documents that were never attached', () => {
  it('attachIframe says whether it accepted the iframe', () => {
    const blocked = setup(() => true);
    expect(blocked.manager.attachIframe(blocked.iframe, blocked.childSn)).toBe(
      false,
    );
    blocked.destroy();
    const open = setup(() => false);
    expect(open.manager.attachIframe(open.iframe, open.childSn)).toBe(true);
    open.destroy();
  });

  it('isDocBlocked answers for an iframe document that was refused (found through its frame element)', () => {
    let blocked = true;
    const t = setup(() => blocked);
    t.manager.attachIframe(t.iframe, t.childSn); // refused: never registered
    const doc = t.iframe.contentDocument!;
    expect(t.manager.isDocBlocked(doc)).toBe(true);
    // released documents stay gated until a new attach, even once the iframe is not blocked any more
    blocked = false;
    expect(t.manager.isDocBlocked(doc)).toBe(true);
    // a fresh document of the same iframe is judged on its own
    const fresh = t.iframe.contentDocument!.implementation.createHTMLDocument();
    expect(t.manager.isDocBlocked(fresh)).toBe(false); // no frame element: not an iframe document
    t.destroy();
  });

  it('never gates the recorded document, even when it is itself inside a blocked iframe', () => {
    const t = setup(() => true);
    expect(t.manager.isDocBlocked(document)).toBe(false);
    t.destroy();
  });

  it('isBlocked follows frame elements for parents that were never attached either', () => {
    const blockedIds = new Set<string>();
    const t = setup((el) => blockedIds.has(el.id));
    t.iframe.id = 'outer';
    const inner = t.iframe.contentDocument!.createElement('iframe');
    inner.id = 'inner';
    t.iframe.contentDocument!.body.appendChild(inner);
    blockedIds.add('outer');
    expect(t.manager.isBlocked(inner)).toBe(true); // outer was never attached
    t.destroy();
  });

  it('isNodeDocBlocked: a node of a blocked iframe document, the document itself, an unknown id, a top node', () => {
    const t = setup(() => true);
    const idoc = t.iframe.contentDocument!;
    const p = idoc.createElement('p');
    idoc.body.appendChild(p);
    // register the nodes in the mirror
    const mirror = (
      t.manager as unknown as { mirror: ReturnType<typeof createMirror> }
    ).mirror;
    mirror.add(p, {
      id: 7001,
      type: 2,
      tagName: 'p',
      attributes: {},
      childNodes: [],
    } as never);
    mirror.add(idoc, { id: 7002, type: 0, childNodes: [] } as never);
    const top = document.createElement('div');
    document.body.appendChild(top);
    mirror.add(top, {
      id: 7003,
      type: 2,
      tagName: 'div',
      attributes: {},
      childNodes: [],
    } as never);
    expect(t.manager.isNodeDocBlocked(7001)).toBe(true);
    expect(t.manager.isNodeDocBlocked(7002)).toBe(true);
    expect(t.manager.isNodeDocBlocked(7003)).toBe(false);
    expect(t.manager.isNodeDocBlocked(424242)).toBe(false);
    t.destroy();
  });

  it('releaseBlockedIframes releases an attached iframe that is blocked now (once), and ignores everything else', () => {
    let blocked = false;
    const t = setup(() => blocked);
    const mirror = (
      t.manager as unknown as { mirror: ReturnType<typeof createMirror> }
    ).mirror;
    mirror.add(t.iframe, {
      id: 9001,
      type: 2,
      tagName: 'iframe',
      attributes: {},
      childNodes: [],
    } as never);
    const holder = document.createElement('section');
    document.body.appendChild(holder);
    holder.appendChild(t.iframe);
    t.manager.attachIframe(t.iframe, t.childSn);
    t.mutationCb.mockClear();
    t.manager.releaseBlockedIframes(holder); // not blocked: nothing
    expect(t.mutationCb).not.toHaveBeenCalled();
    t.manager.releaseBlockedIframes(document.createElement('p')); // unrelated target
    blocked = true;
    t.manager.releaseBlockedIframes(document.createElement('p')); // blocked, but not related to the target
    expect(t.mutationCb).not.toHaveBeenCalled();
    t.manager.releaseBlockedIframes(holder);
    expect(t.mutationCb).toHaveBeenCalledTimes(1);
    expect(t.mutationCb.mock.calls[0][0].attributes[0].id).toBe(9001);
    t.manager.releaseBlockedIframes(holder); // already released
    expect(t.mutationCb).toHaveBeenCalledTimes(1);
    expect(t.unloadListener).toHaveBeenCalledTimes(1);
    t.destroy();
  });

  it('releaseBlockedIframes forgets a disconnected iframe instead of keeping it', () => {
    const t = setup(() => true);
    const holder = document.createElement('section');
    document.body.appendChild(holder);
    holder.appendChild(t.iframe);
    const open = setup(() => false);
    open.manager.attachIframe(open.iframe, open.childSn);
    open.iframe.remove();
    open.manager.releaseBlockedIframes(document.body);
    expect(
      (open.manager as unknown as { attachedIframes: Set<unknown> })
        .attachedIframes.size,
    ).toBe(0);
    t.destroy();
    open.destroy();
  });
});

describe('IframeManager: the recorded document, other frame elements, markers', () => {
  it('never gates the recorded document even when it sits in a blocked frame (it is the rootDocument)', () => {
    const t = setup(() => true);
    const idoc = t.iframe.contentDocument!;
    const rooted = new IframeManager({
      mirror: createMirror(),
      mutationCb: vi.fn(),
      wrappedEmit: vi.fn(),
      stylesheetManager: { styleMirror: { generateId: () => 1 } } as never,
      recordCrossOriginIframes: false,
      isIframeBlocked: () => true,
      rootDocument: idoc,
    });
    expect(rooted.isDocBlocked(idoc)).toBe(false); // its own frame is blocked, it is still the recorded document
    expect(t.manager.isDocBlocked(idoc)).toBe(true); // while for another recorder it is just a blocked frame's document
    const inner = idoc.createElement('iframe');
    idoc.body.appendChild(inner);
    expect(rooted.isBlocked(inner)).toBe(true); // the inner iframe itself is blocked
    t.destroy();
  });

  it('only an IFRAME frame element makes a document an iframe document', () => {
    const t = setup(() => true);
    const fake = (name: string) =>
      ({
        defaultView: { frameElement: { nodeName: name } },
      } as unknown as Document);
    expect(t.manager.isDocBlocked(fake('OBJECT'))).toBe(false);
    expect(
      t.manager.isDocBlocked({ defaultView: null } as unknown as Document),
    ).toBe(false);
    expect(
      t.manager.isDocBlocked({
        defaultView: {
          get frameElement(): never {
            throw new Error('cross-origin');
          },
        },
      } as unknown as Document),
    ).toBe(false);
    t.destroy();
  });

  it('a document of a refused iframe is released silently (no marker: it was never recorded)', () => {
    const t = setup(() => true);
    const mirror = (
      t.manager as unknown as { mirror: ReturnType<typeof createMirror> }
    ).mirror;
    mirror.add(t.iframe, {
      id: 9200,
      type: 2,
      tagName: 'iframe',
      attributes: {},
      childNodes: [],
    } as never);
    t.manager.attachIframe(t.iframe, t.childSn); // refused
    expect(t.manager.isDocBlocked(t.iframe.contentDocument!)).toBe(true);
    expect(t.mutationCb).not.toHaveBeenCalled();
    t.destroy();
  });

  it('no marker for an attached iframe the mirror does not know', () => {
    let blocked = false;
    const t = setup(() => blocked);
    t.manager.attachIframe(t.iframe, t.childSn);
    t.mutationCb.mockClear();
    blocked = true;
    t.manager.releaseBlockedIframes(t.iframe); // the iframe has no id in the mirror
    expect(t.mutationCb).not.toHaveBeenCalled();
    expect(t.unloadListener).toHaveBeenCalledTimes(1); // but it is released
    t.destroy();
  });

  it('the marker carries the iframe size', () => {
    let blocked = false;
    const t = setup(() => blocked);
    const mirror = (
      t.manager as unknown as { mirror: ReturnType<typeof createMirror> }
    ).mirror;
    mirror.add(t.iframe, {
      id: 9100,
      type: 2,
      tagName: 'iframe',
      attributes: {},
      childNodes: [],
    } as never);
    t.iframe.getBoundingClientRect = () =>
      ({ width: 320, height: 200 } as DOMRect);
    t.manager.attachIframe(t.iframe, t.childSn);
    t.mutationCb.mockClear();
    blocked = true;
    t.manager.releaseBlockedIframes(t.iframe);
    expect(t.mutationCb.mock.calls[0][0].attributes[0]).toEqual({
      id: 9100,
      attributes: { rr_width: '320px', rr_height: '200px' },
    });
    t.destroy();
  });

  it('the marker still goes out when the size cannot be read', () => {
    let blocked = false;
    const t = setup(() => blocked);
    const mirror = (
      t.manager as unknown as { mirror: ReturnType<typeof createMirror> }
    ).mirror;
    mirror.add(t.iframe, {
      id: 9101,
      type: 2,
      tagName: 'iframe',
      attributes: {},
      childNodes: [],
    } as never);
    t.iframe.getBoundingClientRect = () => {
      throw new Error('detached');
    };
    t.manager.attachIframe(t.iframe, t.childSn);
    t.mutationCb.mockClear();
    blocked = true;
    t.manager.releaseBlockedIframes(t.iframe);
    expect(t.mutationCb.mock.calls[0][0].attributes[0].attributes).toEqual({
      rr_width: '0px',
      rr_height: '0px',
    });
    t.destroy();
  });
});

describe('isIframeBlocked()', () => {
  const frame = (html: string) => {
    document.body.innerHTML = html;
    return document.querySelector('iframe') as HTMLIFrameElement;
  };

  it('blocks by class, selector and blocked ancestor; unblockSelector opts the element itself back in', () => {
    expect(
      isIframeBlocked(
        frame('<iframe class="rr-block"></iframe>'),
        'rr-block',
        null,
        null,
      ),
    ).toBe(true);
    expect(
      isIframeBlocked(
        frame('<iframe data-x></iframe>'),
        'rr-block',
        '[data-x]',
        null,
      ),
    ).toBe(true);
    expect(
      isIframeBlocked(
        frame('<div class="rr-block"><iframe></iframe></div>'),
        'rr-block',
        null,
        null,
      ),
    ).toBe(true);
    expect(
      isIframeBlocked(frame('<iframe></iframe>'), 'rr-block', null, null),
    ).toBe(false);
    expect(
      isIframeBlocked(
        frame('<iframe class="ok"></iframe>'),
        'rr-block',
        'iframe',
        '.ok',
      ),
    ).toBe(false);
  });

  it('fails closed when the check itself throws', () => {
    // an element whose parent can't be read (the block checks on the element itself pass)
    const odd = {
      matches: () => false,
      classList: { contains: () => false },
    };
    expect(isIframeBlocked(odd as never, 'rr-block', null, null)).toBe(true);
  });
});
