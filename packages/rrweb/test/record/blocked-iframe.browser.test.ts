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
});
