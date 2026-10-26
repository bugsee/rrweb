import * as fs from 'fs';
import * as path from 'path';
import type * as puppeteer from 'puppeteer';
import { vi } from 'vitest';
import type { recordOptions } from '../../src/types';
import {
  EventType,
  IncrementalSource,
  type eventWithTime,
  type listenerHandler,
} from '@rrweb/types';
import { launchPuppeteer, waitForRAF } from '../utils';

// Real Chromium (the jsdom suite is blocked-iframe.test.ts): a blocked same-origin iframe contributes only its
// placeholder, an unblocked one is still recorded, and nothing comes out of an iframe that becomes blocked.

interface IWindow extends Window {
  rrweb: {
    record: ((
      options: recordOptions<eventWithTime>,
    ) => listenerHandler | undefined) & {
      takeFullSnapshot: (isCheckout?: boolean) => void;
    };
  };
  emit: (e: eventWithTime) => undefined;
}

const SECRET = 'BROWSER-IFRAME-SECRET';
const EDIT = 'BROWSER-IFRAME-EDIT';
const LATE = 'BROWSER-IFRAME-LATE';
const CONTROL = 'BROWSER-IFRAME-CONTROL';

describe('blocked same-origin iframes in a real browser', function () {
  vi.setConfig({ testTimeout: 100_000 });

  let browser: puppeteer.Browser;
  let page: puppeteer.Page;
  let code: string;
  let events: eventWithTime[];

  beforeAll(async () => {
    browser = await launchPuppeteer();
    code = fs.readFileSync(
      path.resolve(__dirname, '../../dist/rrweb.umd.cjs'),
      'utf8',
    );
  });
  afterAll(async () => {
    await browser.close();
  });

  const frameHtml = (text: string) =>
    `<p id='t'>${text}</p><input id='i' value='${text}' placeholder='${text}' title='${text}'>`;

  // `opts` are the record() options; the page has a blocked iframe and a control iframe that is recorded.
  const open = async (
    opts: Record<string, unknown>,
    blockedAttrs = "class='rr-block'",
  ) => {
    page = await browser.newPage();
    await page.goto('about:blank');
    await page.setContent(`<!DOCTYPE html><html><body>
      <iframe id='blocked' ${blockedAttrs} srcdoc="${frameHtml(
      SECRET,
    )}"></iframe>
      <iframe id='control' class='ok' srcdoc="${frameHtml(CONTROL)}"></iframe>
    </body></html>`);
    await page.evaluate(code);
    events = [];
    await page.exposeFunction('emit', (e: eventWithTime) => {
      if (e.type === EventType.DomContentLoaded || e.type === EventType.Load)
        return;
      events.push(e);
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          // wait until both srcdoc documents are loaded
          const ready = () =>
            [...document.querySelectorAll('iframe')].every(
              (f) =>
                f.contentDocument?.readyState === 'complete' &&
                f.contentDocument.getElementById('t'),
            );
          const check = () => (ready() ? resolve() : setTimeout(check, 20));
          check();
        }),
    );
    await page.evaluate((o) => {
      const win = window as unknown as IWindow;
      win.rrweb.record({ emit: win.emit, ...o } as never);
    }, opts as never);
    await waitForRAF(page);
    await new Promise((r) => setTimeout(r, 300)); // iframe load timers
  };

  afterEach(async () => {
    await page?.close();
  });

  const dump = () => JSON.stringify(events);

  const edit = (frameId: string, value: string) =>
    page.evaluate(
      (id, v) => {
        const f = document.getElementById(id) as HTMLIFrameElement;
        const d = f.contentDocument!;
        d.getElementById('t')!.firstChild!.nodeValue = v;
        const i = d.getElementById('i') as HTMLInputElement;
        i.value = v;
        i.dispatchEvent(new Event('input', { bubbles: true }));
        i.setAttribute('placeholder', v);
        const p = d.createElement('p');
        p.textContent = v;
        d.body.appendChild(p);
        d.dispatchEvent(new Event('scroll'));
      },
      frameId,
      value,
    );

  const navigate = (frameId: string, html: string) =>
    page.evaluate(
      (id, h) =>
        new Promise<void>((resolve) => {
          const f = document.getElementById(id) as HTMLIFrameElement;
          f.addEventListener('load', () => resolve(), { once: true });
          f.srcdoc = h;
        }),
      frameId,
      html,
    );

  const expectNoLeak = () => {
    expect(dump()).toContain(CONTROL); // control iframe was recorded
    for (const s of [SECRET, EDIT, LATE]) expect(dump()).not.toContain(s);
  };

  const placeholders = () => {
    const out: Array<{ childNodes: unknown[]; attributes: object }> = [];
    const walk = (n: any) => {
      if (n.tagName === 'iframe' && 'rr_width' in (n.attributes ?? {}))
        out.push(n);
      (n.childNodes ?? []).forEach(walk);
    };
    events
      .filter((e) => e.type === EventType.FullSnapshot)
      .forEach((e) => walk((e.data as any).node));
    return out;
  };

  it('blocked by class: placeholder only, before and after edits, navigation and a new snapshot', async () => {
    await open({});
    await edit('blocked', EDIT);
    await edit('control', CONTROL + '-2');
    await navigate('blocked', frameHtml(LATE));
    await edit('blocked', LATE);
    await page.evaluate(() =>
      (window as unknown as IWindow).rrweb.record.takeFullSnapshot(true),
    );
    await waitForRAF(page);
    await edit('blocked', LATE);
    await waitForRAF(page);
    expectNoLeak();
    expect(placeholders().length).toBeGreaterThan(0);
    placeholders().forEach((p) => expect(p.childNodes).toEqual([]));
  });

  it('blocked by selector with maskAllText off: nothing from the iframe at all', async () => {
    await open({ blockSelector: 'iframe:not(.ok)', maskAllText: false }, '');
    await edit('blocked', EDIT);
    await navigate('blocked', frameHtml(LATE));
    await waitForRAF(page);
    expectNoLeak();
    expect(placeholders().length).toBeGreaterThan(0);
  });

  it('blocked iframe removed and added again stays a placeholder', async () => {
    await open({});
    await page.evaluate(() => {
      const f = document.getElementById('blocked')!;
      f.remove();
      document.body.appendChild(f);
    });
    await waitForRAF(page);
    await new Promise((r) => setTimeout(r, 300));
    await edit('blocked', EDIT);
    await waitForRAF(page);
    expectNoLeak();
    const readded = events
      .filter(
        (e) =>
          e.type === EventType.IncrementalSnapshot &&
          e.data.source === IncrementalSource.Mutation,
      )
      .flatMap((e) => (e.data as any).adds)
      .filter((a: any) => a.node.tagName === 'iframe');
    expect(readded.length).toBeGreaterThan(0);
    readded.forEach((a: any) => expect(a.node.childNodes).toEqual([]));
  });

  it('an explicitly unblocked iframe is still recorded, live edits included', async () => {
    await open(
      { blockSelector: 'iframe', unblockSelector: '.ok' },
      "class='nope'",
    );
    await edit('control', EDIT);
    await waitForRAF(page);
    expect(dump()).toContain(CONTROL);
    expect(dump()).toContain(EDIT);
    expect(dump()).not.toContain(SECRET);
  });

  it('an iframe that becomes blocked stops reporting at once', async () => {
    await open({}, '');
    await edit('blocked', 'BEFORE-BLOCK');
    await waitForRAF(page);
    expect(dump()).toContain('BEFORE-BLOCK');
    await page.evaluate(() => {
      const f = document.getElementById('blocked')!;
      f.classList.add('rr-block');
      // same task as the class change
      const d = (f as HTMLIFrameElement).contentDocument!;
      d.getElementById('t')!.firstChild!.nodeValue = 'AFTER-BLOCK-SAME-TASK';
    });
    await waitForRAF(page);
    await edit('blocked', 'AFTER-BLOCK-LATER');
    await waitForRAF(page);
    expect(dump()).not.toContain('AFTER-BLOCK');
  });

  // --- iframes that are refused or released AFTER they were recorded -------------------------------------------
  const SHEET = 'STYLE-SECRET-VALUE';

  /** A page with one recorded (explicitly unblocked) iframe inside `#wrap`, recording started. */
  const openRecorded = async (
    opts: Record<string, unknown>,
    srcdoc: string,
  ) => {
    page = await browser.newPage();
    await page.goto('about:blank');
    await page.setContent(`<!DOCTYPE html><html><body>
      <div id='wrap'><iframe id='a' class='ok' srcdoc="${srcdoc}"></iframe></div></body></html>`);
    await page.evaluate(code);
    events = [];
    await page.exposeFunction('emit', (e: eventWithTime) => {
      if (e.type === EventType.DomContentLoaded || e.type === EventType.Load)
        return;
      events.push(e);
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const check = () =>
            (document.getElementById('a') as HTMLIFrameElement).contentDocument
              ?.readyState === 'complete'
              ? resolve()
              : setTimeout(check, 20);
          check();
        }),
    );
    await page.evaluate((o) => {
      const win = window as unknown as IWindow;
      win.rrweb.record({
        emit: win.emit,
        blockSelector: 'iframe:not(.ok)',
        ...o,
      } as never);
    }, opts as never);
    await waitForRAF(page);
    await new Promise((r) => setTimeout(r, 300));
  };

  const adopt = () =>
    page.evaluate((v) => {
      const f = document.getElementById('a') as HTMLIFrameElement;
      const w = f.contentWindow as unknown as {
        CSSStyleSheet: typeof CSSStyleSheet;
      };
      const sheet = new w.CSSStyleSheet();
      sheet.replaceSync(`p::after{content:"${v}"}`);
      (f.contentDocument as Document).adoptedStyleSheets = [sheet];
    }, SHEET);

  const markerCount = () =>
    events.filter((e) => {
      const d = e.data as any;
      return (
        e.type === EventType.IncrementalSnapshot &&
        d.source === IncrementalSource.Mutation &&
        d.attributes?.length === 1 &&
        'rr_width' in d.attributes[0].attributes
      );
    }).length;

  it('control: an unblocked recorded iframe reports the stylesheet it adopts', async () => {
    await openRecorded({}, '<p>x</p>');
    await adopt();
    await waitForRAF(page);
    expect(dump()).toContain(SHEET);
  });

  it('an ancestor becomes blocked, the iframe reloads, a shadow root is attached in it: nothing is recorded', async () => {
    await openRecorded(
      { maskAllText: false },
      "<div id='h'></div><script>document.getElementById('h').textContent = parent.__reloaded ? 'RELOADED-' + 'SECRET' : 'first'</script>",
    );
    await page.evaluate(() =>
      document.getElementById('wrap')!.classList.add('rr-block'),
    );
    await waitForRAF(page);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const f = document.getElementById('a') as HTMLIFrameElement;
          f.addEventListener('load', () => resolve(), { once: true });
          (window as unknown as { __reloaded: boolean }).__reloaded = true;
          f.contentWindow!.location.reload();
        }),
    );
    await new Promise((r) => setTimeout(r, 300));
    await page.evaluate(() => {
      const d = (document.getElementById('a') as HTMLIFrameElement)
        .contentDocument!;
      d.getElementById('h')!.attachShadow({ mode: 'open' }).innerHTML =
        '<p>SHADOW-SECRET-ONE</p>';
    });
    await new Promise((r) => setTimeout(r, 300));
    await page.evaluate(() => {
      const d = (document.getElementById('a') as HTMLIFrameElement)
        .contentDocument!;
      const root = d.getElementById('h')!.shadowRoot!;
      const p = d.createElement('p');
      p.textContent = 'SHADOW-SECRET-TWO';
      root.appendChild(p);
    });
    await waitForRAF(page);
    for (const secret of ['RELOADED-SECRET', 'SHADOW-SECRET'])
      expect(dump()).not.toContain(secret);
    expect(markerCount()).toBe(1);
  });

  it('the iframe loses its unblock class, then adopts a stylesheet: nothing is recorded', async () => {
    await openRecorded({ maskAllText: false }, '<p>x</p>');
    await page.evaluate(() =>
      document.getElementById('a')!.classList.remove('ok'),
    );
    await waitForRAF(page);
    await adopt();
    await waitForRAF(page);
    expect(dump()).not.toContain(SHEET);
    expect(markerCount()).toBe(1);
  });

  it('an ancestor becomes blocked, then the iframe adopts a stylesheet: nothing is recorded', async () => {
    await openRecorded({ maskAllText: false }, '<p>x</p>');
    await page.evaluate(() =>
      document.getElementById('wrap')!.classList.add('rr-block'),
    );
    await waitForRAF(page);
    await adopt();
    await waitForRAF(page);
    expect(dump()).not.toContain(SHEET);
  });

  const linkPage = async (block: boolean) => {
    page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().startsWith('http://slow.invalid/')) {
        setTimeout(
          () =>
            req.respond({
              status: 200,
              contentType: 'text/css',
              headers: { 'Access-Control-Allow-Origin': '*' },
              body: `p::after{content:"${SHEET}"}`,
            }),
          700,
        );
      } else {
        void req.continue();
      }
    });
    await page.goto('about:blank');
    await page.setContent(`<!DOCTYPE html><html><body><div id='wrap'><iframe id='a' class='ok'
      srcdoc="<p>x</p>"></iframe></div></body></html>`);
    await page.evaluate(code);
    events = [];
    await page.exposeFunction('emit', (e: eventWithTime) => {
      if (e.type === EventType.DomContentLoaded || e.type === EventType.Load)
        return;
      events.push(e);
    });
    await page.evaluate(() => {
      const win = window as unknown as IWindow;
      win.rrweb.record({
        emit: win.emit,
        blockSelector: 'iframe:not(.ok)',
        inlineStylesheet: true,
      } as never);
    });
    await new Promise((r) => setTimeout(r, 300));
    // a stylesheet added while recording: it is still loading when the iframe is blocked
    await page.evaluate(() => {
      const d = (document.getElementById('a') as HTMLIFrameElement)
        .contentDocument!;
      const link = d.createElement('link');
      link.rel = 'stylesheet';
      link.crossOrigin = 'anonymous'; // a CORS-enabled sheet is readable (and so inlined)
      link.href = 'http://slow.invalid/s.css';
      d.head.appendChild(link);
    });
    await new Promise((r) => setTimeout(r, 200));
    if (block)
      await page.evaluate(() =>
        document.getElementById('a')!.classList.remove('ok'),
      );
    await new Promise((r) => setTimeout(r, 1500)); // it finishes now
  };

  it('control: a <link> stylesheet that finishes loading in a recorded iframe is reported', async () => {
    await linkPage(false);
    expect(dump()).toContain(SHEET);
  });

  it('a <link> stylesheet that finishes loading after the iframe became blocked is not recorded', async () => {
    await linkPage(true);
    expect(dump()).not.toContain(SHEET);
    expect(markerCount()).toBe(1);
  });

  it('an adopted style sheet set in the same task as the change that blocks the iframe is not recorded', async () => {
    await openRecorded({ maskAllText: false }, '<p>x</p>');
    await page.evaluate((v) => {
      document.getElementById('a')!.classList.remove('ok');
      const f = document.getElementById('a') as HTMLIFrameElement;
      const w = f.contentWindow as unknown as {
        CSSStyleSheet: typeof CSSStyleSheet;
      };
      const sheet = new w.CSSStyleSheet();
      sheet.replaceSync(`p::after{content:"${v}"}`);
      (f.contentDocument as Document).adoptedStyleSheets = [sheet];
    }, SHEET);
    await new Promise((r) => setTimeout(r, 400));
    expect(dump()).not.toContain(SHEET);
  });

  const selectInFrame = () =>
    page.evaluate(() => {
      const d = (document.getElementById('a') as HTMLIFrameElement)
        .contentDocument!;
      d.getSelection()!.selectAllChildren(d.body);
    });
  const selections = () =>
    events.filter(
      (e) =>
        e.type === EventType.IncrementalSnapshot &&
        e.data.source === IncrementalSource.Selection,
    ).length;

  // rrweb's selection observer listens on the TOP document only, so a selection inside an iframe is not recorded
  // even while the iframe is allowed (no control possible); this pins that it stays out for a blocked one too.
  it('a text selection made in the same task as the change that blocks the iframe is not reported', async () => {
    await openRecorded({}, '<p>x</p>');
    await page.evaluate(() => {
      document.getElementById('a')!.classList.remove('ok');
      const d = (document.getElementById('a') as HTMLIFrameElement)
        .contentDocument!;
      d.getSelection()!.selectAllChildren(d.body);
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(selections()).toBe(0);
  });

  const fonts = () =>
    events.filter(
      (e) =>
        e.type === EventType.IncrementalSnapshot &&
        e.data.source === IncrementalSource.Font,
    ).length;
  const addFont = () =>
    page.evaluate(() => {
      const w = (document.getElementById('a') as HTMLIFrameElement)
        .contentWindow as unknown as {
        FontFace: typeof FontFace;
        document: Document;
      };
      const face = new w.FontFace(
        'LateFont',
        'url(data:font/woff2;base64,AAAA)',
      );
      w.document.fonts.add(face);
    });

  it('control: a font added in a recorded iframe is reported (collectFonts)', async () => {
    await openRecorded({ collectFonts: true }, '<p>x</p>');
    await addFont();
    await new Promise((r) => setTimeout(r, 300));
    expect(fonts()).toBeGreaterThan(0);
  });

  it('a font added in the same task as the change that blocks the iframe is not reported', async () => {
    await openRecorded({ collectFonts: true }, '<p>x</p>');
    await page.evaluate(() =>
      document.getElementById('a')!.classList.remove('ok'),
    );
    await addFont();
    await new Promise((r) => setTimeout(r, 400));
    expect(fonts()).toBe(0);
  });
});
