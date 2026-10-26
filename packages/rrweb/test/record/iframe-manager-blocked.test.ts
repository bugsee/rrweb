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
