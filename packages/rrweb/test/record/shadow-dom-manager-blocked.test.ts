/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Mirror, snapshot } from 'rrweb-snapshot';
import { ShadowDomManager } from '../../src/record/shadow-dom-manager';

type BypassOptions = ConstructorParameters<
  typeof ShadowDomManager
>[0]['bypassOptions'];

// Unit level: a ShadowDomManager asked about a blocked iframe document must neither observe new shadow roots in
// it nor let an already observed one report (each guard on its own; the integration tests can't separate them).

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const managers: ShadowDomManager[] = [];

const setup = (isDocBlocked?: (doc: Document) => boolean) => {
  const adoptStyleSheets = vi.fn();
  const doc = document.implementation.createHTMLDocument();
  doc.body.innerHTML = '<div id="host"></div>';
  const mirror = new Mirror();
  snapshot(doc, { mirror });
  const mutationCb = vi.fn();
  const scrollCb = vi.fn();
  const manager = new ShadowDomManager({
    mutationCb,
    scrollCb,
    isDocBlocked,
    bypassOptions: {
      blockClass: 'rr-block',
      blockSelector: null,
      unblockSelector: null,
      maskAllText: false,
      maskTextClass: 'rr-mask',
      unmaskTextClass: null,
      maskTextSelector: null,
      unmaskTextSelector: null,
      inlineStylesheet: true,
      maskInputOptions: {},
      keepIframeSrcFn: () => false,
      recordCanvas: false,
      inlineImages: false,
      sampling: {},
      slimDOMOptions: {},
      dataURLOptions: {},
      iframeManager: { addIframe: vi.fn(), attachIframe: vi.fn() },
      stylesheetManager: {
        trackLinkElement: vi.fn(),
        attachLinkElement: vi.fn(),
        adoptStyleSheets,
      },
      canvasManager: {
        addShadowRoot: vi.fn(),
        resetShadowRoots: vi.fn(),
        addWindow: vi.fn(),
      },
      processedNodeManager: {
        inOtherBuffer: () => false,
        add: () => undefined,
      },
      ignoreCSSAttributes: new Set<string>(),
    } as unknown as BypassOptions,
    mirror,
  });
  const host = doc.getElementById('host')!;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<b id="b">x</b>';
  // the shadow content has to be known to the mirror to be reported
  snapshot(doc, { mirror });
  managers.push(manager);
  return { doc, manager, mutationCb, scrollCb, host, root, adoptStyleSheets };
};

const observed = (m: ShadowDomManager) =>
  (m as unknown as { shadowDoms: Map<unknown, unknown> }).shadowDoms;

describe('ShadowDomManager and a blocked iframe document', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    managers.splice(0).forEach((m) => m.reset());
  });

  it('does not observe a shadow root of a blocked document', () => {
    const t = setup(() => true);
    t.manager.addShadowRoot(t.root, t.doc);
    expect(observed(t.manager).size).toBe(0);
  });

  it('asks about the document the shadow root lives in, not the one it is passed (the snapshot passes the top document)', () => {
    let asked: Document | undefined;
    // the shadow root's document is the one that has the host in it
    const t = setup((d) => {
      asked = d;
      return d.getElementById('host') !== null;
    });
    t.manager.addShadowRoot(t.root, document);
    expect(asked).toBe(t.doc);
    expect(observed(t.manager).size).toBe(0);
  });

  it('observes it when the document is not blocked (control)', () => {
    const t = setup(() => false);
    t.manager.addShadowRoot(t.root, t.doc);
    expect(observed(t.manager).size).toBe(1);
  });

  it('observes by default when no gate is given (control)', () => {
    const t = setup();
    t.manager.addShadowRoot(t.root, t.doc);
    expect(observed(t.manager).size).toBe(1);
  });

  it('stops forwarding mutations of an observed shadow root once its document is blocked', async () => {
    let blocked = false;
    const t = setup(() => blocked);
    t.manager.addShadowRoot(t.root, t.doc);
    t.root.getElementById('b')!.firstChild!.nodeValue = 'visible';
    await tick();
    expect(t.mutationCb).toHaveBeenCalledTimes(1); // control

    blocked = true;
    t.root.getElementById('b')!.firstChild!.nodeValue = 'SECRET';
    await tick();
    expect(t.mutationCb).toHaveBeenCalledTimes(1);
  });

  it('stops forwarding scrolls of an observed shadow root once its document is blocked', async () => {
    let blocked = false;
    const t = setup(() => blocked);
    t.manager.addShadowRoot(t.root, t.doc);
    const b = t.root.getElementById('b')!;
    b.dispatchEvent(new Event('scroll'));
    await tick();
    expect(t.scrollCb).toHaveBeenCalledTimes(1); // control

    blocked = true;
    await new Promise((resolve) => setTimeout(resolve, 150)); // scroll sampling is throttled
    b.dispatchEvent(new Event('scroll'));
    await tick();
    expect(t.scrollCb).toHaveBeenCalledTimes(1);
  });

  it('does not report adopted style sheets of a shadow root whose document got blocked in the meantime', async () => {
    let blocked = false;
    const t = setup(() => blocked);
    Object.defineProperty(t.root, 'adoptedStyleSheets', { value: [{}] });
    t.manager.addShadowRoot(t.root, t.doc); // the adopted sheets are looked at on the next task
    blocked = true;
    await tick();
    expect(t.adoptStyleSheets).not.toHaveBeenCalled();
  });

  it('reports adopted style sheets of a shadow root in an unblocked document (control)', async () => {
    const t = setup(() => false);
    Object.defineProperty(t.root, 'adoptedStyleSheets', { value: [{}] });
    t.manager.addShadowRoot(t.root, t.doc);
    await tick();
    expect(t.adoptStyleSheets).toHaveBeenCalledTimes(1);
  });
});
