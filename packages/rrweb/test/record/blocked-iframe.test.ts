/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EventType, IncrementalSource, type eventWithTime } from '@rrweb/types';
import { record } from '../../src';

// A BLOCKED same-origin iframe (blockClass / blockSelector, honouring unblockSelector) must contribute only its
// placeholder (width/height, no children, no contentDocument): nothing from inside it may be serialized, observed
// or emitted, at snapshot time, on load/navigation/re-add, or after the block state changes. Not-blocked iframes
// (explicit unblockSelector, or simply not matching) must still be recorded, or the fix would just disable iframe
// recording. Every blocked scenario asserts that a control secret in a NOT blocked frame IS recorded, so a
// broken harness cannot pass vacuously.

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

const SECRET = 'IFRAME-SECRET-VALUE';
const EDIT = 'IFRAME-SECRET-EDIT';
const LATE = 'IFRAME-SECRET-LATE';
const CONTROL = 'IFRAME-CONTROL-VISIBLE';

type SNode = {
  type: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SNode[];
  textContent?: string;
};

const dump = (events: eventWithTime[]) => JSON.stringify(events);

const walk = (n: SNode, fn: (n: SNode) => void) => {
  fn(n);
  (n.childNodes ?? []).forEach((c) => walk(c, fn));
};

const fullSnapshots = (events: eventWithTime[]) =>
  events.filter((e) => e.type === EventType.FullSnapshot);

const serializedIframes = (events: eventWithTime[]) => {
  const out: SNode[] = [];
  for (const e of fullSnapshots(events)) {
    walk((e.data as { node: SNode }).node, (n) => {
      if (n.tagName === 'iframe') out.push(n);
    });
  }
  return out;
};

const incremental = (events: eventWithTime[], source: IncrementalSource) =>
  events.filter(
    (e) =>
      e.type === EventType.IncrementalSnapshot &&
      (e.data as { source: number }).source === source,
  );

const attachIframeMutations = (events: eventWithTime[]) =>
  incremental(events, IncrementalSource.Mutation).filter(
    (e) => (e.data as { isAttachIframe?: boolean }).isAttachIframe,
  );

const mutationAdds = (events: eventWithTime[]) =>
  incremental(events, IncrementalSource.Mutation).flatMap(
    (e) => (e.data as { adds: Array<{ node: SNode }> }).adds,
  );

describe('blocked same-origin iframes contribute only a placeholder', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
    document.body.innerHTML = '';
  });

  const makeFrame = (
    attrs: Record<string, string>,
    html = `<p id="t">${SECRET}</p><input id="i" type="text" placeholder="${SECRET}" title="${SECRET}">`,
  ) => {
    const iframe = document.createElement('iframe');
    Object.entries(attrs).forEach(([k, v]) => iframe.setAttribute(k, v));
    document.body.appendChild(iframe);
    iframe.contentDocument!.body.innerHTML = html;
    return iframe;
  };

  const start = (extra: Record<string, unknown> = {}) => {
    const events: eventWithTime[] = [];
    stop = record({
      emit: (event) => events.push(event),
      maskAllInputs: false,
      maskAllText: false,
      recordCrossOriginIframes: false,
      ...extra,
    } as Parameters<typeof record>[0]);
    return events;
  };

  // Edits, typing, a new element, an attribute change, a scroll and a shadow root: every observer the recorder
  // would attach to an iframe document gets something to report.
  const poke = async (iframe: HTMLIFrameElement, value: string) => {
    const idoc = iframe.contentDocument!;
    const win = iframe.contentWindow!;
    const t = idoc.getElementById('t');
    if (t?.firstChild) t.firstChild.nodeValue = value;
    const input = idoc.getElementById('i') as HTMLInputElement | null;
    if (input) {
      input.value = value;
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      input.setAttribute('placeholder', value);
    }
    const p = idoc.createElement('p');
    p.textContent = value;
    idoc.body.appendChild(p);
    const host = idoc.createElement('div');
    idoc.body.appendChild(host);
    host.attachShadow({ mode: 'open' }).innerHTML = `<b>${value}</b>`;
    idoc.dispatchEvent(new win.Event('scroll'));
    await tick();
  };

  const withControl = (blocked: Record<string, string>) => {
    const control = makeFrame(
      { id: 'control', class: 'ok' },
      `<p>${CONTROL}</p>`,
    );
    const frame = makeFrame({ id: 'blocked', ...blocked });
    return { control, frame };
  };

  const expectPlaceholderOnly = (events: eventWithTime[]) => {
    const text = dump(events);
    expect(text).toContain(CONTROL); // harness can see iframe content
    for (const s of [SECRET, EDIT, LATE]) expect(text).not.toContain(s);
    const blocked = serializedIframes(events).filter(
      (n) =>
        n.attributes?.id === 'blocked' || 'rr_width' in (n.attributes ?? {}),
    );
    expect(blocked.length).toBeGreaterThan(0);
    for (const n of blocked) {
      expect(n.childNodes).toEqual([]);
      expect(n.attributes).toHaveProperty('rr_width');
      expect(n.attributes).toHaveProperty('rr_height');
    }
  };

  const BLOCKERS: Array<[string, Record<string, string>, object]> = [
    ['blockClass', { class: 'rr-block' }, {}],
    [
      'custom blockClass',
      { class: 'secret-frame' },
      { blockClass: 'secret-frame' },
    ],
    ['regex blockClass', { class: 'xx-secret' }, { blockClass: /secret$/ }],
    [
      'blockSelector',
      { 'data-private': '1' },
      { blockSelector: '[data-private]' },
    ],
    [
      'tag blockSelector (the SDK default media selector)',
      {},
      { blockSelector: 'iframe:not(.ok)' },
    ],
  ];

  describe.each(BLOCKERS)('blocked by %s', (_name, attrs, opts) => {
    it('serializes a placeholder and nothing from inside, before and after live edits', async () => {
      const { control, frame } = withControl(attrs);
      const events = start(opts);
      await tick();
      await poke(frame, EDIT);
      await poke(control, CONTROL + '-2');

      expectPlaceholderOnly(events);
      // the blocked frame was never attached
      expect(attachIframeMutations(events)).toHaveLength(1); // only the control
    });

    it('records nothing when the blocked frame loads, navigates or is rewritten', async () => {
      const { frame } = withControl(attrs);
      const events = start(opts);
      await tick();
      frame.dispatchEvent(new Event('load'));
      const idoc = frame.contentDocument!;
      idoc.open();
      idoc.write(`<html><body><p id="t">${LATE}</p></body></html>`);
      idoc.close();
      frame.dispatchEvent(new Event('load'));
      await tick();
      await poke(frame, EDIT);
      expectPlaceholderOnly(events);
    });

    it('records nothing when the blocked frame is removed and added again', async () => {
      const { frame } = withControl(attrs);
      const events = start(opts);
      await tick();
      frame.remove();
      await tick();
      document.body.appendChild(frame);
      await tick();
      frame.dispatchEvent(new Event('load'));
      await poke(frame, LATE);
      expectPlaceholderOnly(events);
      // the re-added placeholder was emitted (so the add path really ran)
      const readded: SNode[] = [];
      mutationAdds(events).forEach((a) =>
        walk(a.node, (n) => {
          if (n.tagName === 'iframe') readded.push(n);
        }),
      );
      expect(readded.length).toBeGreaterThan(0);
      readded.forEach((n) => expect(n.childNodes).toEqual([]));
    });

    it('records nothing for a blocked frame created while recording', async () => {
      const events = start(opts);
      await tick();
      const frame = makeFrame({ id: 'blocked', ...attrs });
      await tick();
      frame.dispatchEvent(new Event('load'));
      await poke(frame, EDIT);
      const text = dump(events);
      for (const s of [SECRET, EDIT]) expect(text).not.toContain(s);
      expect(attachIframeMutations(events)).toHaveLength(0);
      expect(
        mutationAdds(events).some((a) => a.node.tagName === 'iframe'),
      ).toBe(true);
    });

    it('stays a placeholder across later full snapshots', async () => {
      const { frame } = withControl(attrs);
      const events = start(opts);
      await tick();
      record.takeFullSnapshot(true);
      await tick();
      await poke(frame, EDIT);
      expectPlaceholderOnly(events);
      expect(fullSnapshots(events).length).toBeGreaterThan(1);
    });
  });

  describe('unblockSelector', () => {
    const opts = {
      blockSelector: 'iframe',
      unblockSelector: '.allowed',
    };

    it('still records an explicitly unblocked iframe and keeps blocking its neighbour', async () => {
      const allowed = makeFrame(
        { id: 'allowed', class: 'allowed' },
        `<p id="t">${CONTROL}</p>`,
      );
      makeFrame({ id: 'blocked' });
      const events = start(opts);
      await tick();
      await poke(allowed, EDIT);

      const text = dump(events);
      expect(text).toContain(CONTROL);
      expect(text).toContain(EDIT); // live edits in the allowed frame
      expect(text).not.toContain(SECRET);
      expect(attachIframeMutations(events)).toHaveLength(1);
      const frames = serializedIframes(events);
      // the blocked neighbour is a placeholder (a placeholder keeps only class + size, not the id)
      const placeholder = frames.find(
        (n) => 'rr_width' in (n.attributes ?? {}),
      );
      expect(placeholder).toBeDefined();
      expect(placeholder!.childNodes).toEqual([]);
    });

    it('records an unblocked iframe that is added while recording', async () => {
      const events = start(opts);
      await tick();
      const allowed = makeFrame(
        { id: 'allowed', class: 'allowed' },
        `<p id="t">${CONTROL}</p>`,
      );
      await tick();
      allowed.dispatchEvent(new Event('load'));
      await tick();
      expect(dump(events)).toContain(CONTROL);
    });
  });

  describe('block state changing while recording', () => {
    // An iframe document with every kind of thing the recorder observes: text, an input, a host that gets a
    // shadow root later, a shadow root that exists from the start, a scrollable and a clickable element.
    const richFrame = (attrs: Record<string, string> = {}) => {
      const frame = makeFrame(
        attrs,
        '<p id="t">text</p><input id="i" type="text"><div id="h0"></div><div id="h1"></div><div id="h2"></div><div id="h3"></div><div id="h4"></div><div id="sh"></div>',
      );
      const sh = frame.contentDocument!.getElementById('sh')!;
      sh.attachShadow({ mode: 'open' }).innerHTML = '<b id="sb">shadow</b>';
      return frame;
    };

    // Reports something through every observer of the iframe document, including its shadow roots.
    const pokes = new WeakMap<HTMLIFrameElement, number>();
    const pokeRich = async (frame: HTMLIFrameElement, value: string) => {
      const n = pokes.get(frame) ?? 0; // each poke uses a fresh shadow host (a host takes one shadow root)
      pokes.set(frame, n + 1);
      const idoc = frame.contentDocument!;
      const win = frame.contentWindow!;
      idoc.getElementById('t')!.firstChild!.nodeValue = value;
      const input = idoc.getElementById('i') as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      input.setAttribute('placeholder', value);
      idoc
        .getElementById('t')!
        .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      idoc.dispatchEvent(new win.Event('scroll'));
      const p = idoc.createElement('p');
      p.textContent = value;
      idoc.body.appendChild(p);
      // a shadow root created now, on a host the recorder already knows
      idoc
        .getElementById(`h${n}`)!
        .attachShadow({ mode: 'open' }).innerHTML = `<i>${value}</i>`;
      // and a change inside the shadow root that was there from the start
      const root = idoc.getElementById('sh')!.shadowRoot!;
      root.getElementById('sb')!.firstChild!.nodeValue = value;
      root.getElementById('sb')!.dispatchEvent(new win.Event('scroll'));
      await tick();
    };

    it('stops emitting anything from inside an iframe that becomes blocked', async () => {
      const frame = richFrame();
      const events = start();
      await tick();
      // control: while it is not blocked every observer reports
      await pokeRich(frame, 'BEFORE-BLOCK');
      const sources = new Set(
        events
          .filter((e) => e.type === EventType.IncrementalSnapshot)
          .map((e) => (e.data as { source: number }).source),
      );
      for (const s of [
        IncrementalSource.Mutation,
        IncrementalSource.Input,
        IncrementalSource.Scroll,
        IncrementalSource.MouseInteraction,
      ])
        expect(sources.has(s)).toBe(true);
      expect(dump(events)).toContain('BEFORE-BLOCK');

      frame.classList.add('rr-block');
      const before = events.length;
      await pokeRich(frame, EDIT);
      frame.dispatchEvent(new Event('load'));
      await pokeRich(frame, LATE);

      // not just "no secret": no event of any kind comes out of the blocked iframe
      expect(events.slice(before)).toEqual([]);
    });

    // Each observer on its own, as the FIRST thing that happens after the iframe became blocked (the first
    // thing that reaches the gate releases the whole iframe, so a later one would hide a missing guard).
    const ACTIONS: Array<[string, (doc: Document, win: Window) => void]> = [
      [
        'a text edit',
        (doc) => {
          doc.getElementById('t')!.firstChild!.nodeValue = EDIT;
        },
      ],
      [
        'typing',
        (doc, win) => {
          const i = doc.getElementById('i') as HTMLInputElement;
          i.value = EDIT;
          i.dispatchEvent(new win.Event('input', { bubbles: true }));
        },
      ],
      [
        'a click',
        (doc, win) => {
          doc
            .getElementById('t')!
            .dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
        },
      ],
      ['a scroll', (doc, win) => doc.dispatchEvent(new win.Event('scroll'))],
      [
        'a new shadow root on a known host',
        (doc) => {
          doc
            .getElementById('h0')!
            .attachShadow({ mode: 'open' }).innerHTML = `<i>${EDIT}</i>`;
        },
      ],
      [
        'an edit inside an existing shadow root',
        (doc) => {
          doc
            .getElementById('sh')!
            .shadowRoot!.getElementById('sb')!.firstChild!.nodeValue = EDIT;
        },
      ],
      [
        'a scroll inside an existing shadow root',
        (doc, win) => {
          doc
            .getElementById('sh')!
            .shadowRoot!.getElementById('sb')!
            .dispatchEvent(new win.Event('scroll'));
        },
      ],
    ];

    it.each(ACTIONS)(
      'stops at once for %s made in the same task as the class change',
      async (_name, act) => {
        const frame = richFrame();
        const events = start();
        await tick();
        frame.classList.add('rr-block');
        const before = events.length;
        // no await in between: the iframe's own observers run before the parent document processes the class change
        act(frame.contentDocument!, frame.contentWindow!);
        await tick();
        expect(events.slice(before)).toEqual([]);
      },
    );

    it('does not resume recording on its own when the iframe is unblocked again (only a new full snapshot does)', async () => {
      const frame = richFrame();
      const events = start();
      await tick();
      frame.classList.add('rr-block');
      await pokeRich(frame, EDIT); // the recording of the iframe is released here
      frame.classList.remove('rr-block');
      await tick();
      const before = events.length;
      await pokeRich(frame, 'WHILE-UNBLOCKED');
      expect(events.slice(before)).toEqual([]);

      record.takeFullSnapshot(true);
      await tick();
      const mark = events.length;
      await pokeRich(frame, 'AFTER-RESNAP');
      expect(dump(events.slice(mark))).toContain('AFTER-RESNAP');
    });

    it('stops an iframe whose container becomes blocked', async () => {
      const box = document.createElement('div');
      document.body.appendChild(box);
      const frame = document.createElement('iframe');
      box.appendChild(frame);
      frame.contentDocument!.body.innerHTML = '<p id="t">x</p>';
      const events = start();
      await tick();
      frame.contentDocument!.getElementById('t')!.firstChild!.nodeValue =
        'BEFORE-BLOCK';
      await tick();
      expect(dump(events)).toContain('BEFORE-BLOCK');

      box.classList.add('rr-block');
      frame.contentDocument!.getElementById('t')!.firstChild!.nodeValue = EDIT;
      await tick();
      expect(dump(events)).not.toContain(EDIT);
    });

    it('stops a nested iframe when its outer iframe becomes blocked', async () => {
      const outer = makeFrame({ id: 'outer' }, '<p>outer</p>');
      const odoc = outer.contentDocument!;
      const inner = odoc.createElement('iframe');
      odoc.body.appendChild(inner);
      inner.contentDocument!.body.innerHTML = '<p id="t">nested</p>';
      const events = start();
      await tick();
      inner.contentDocument!.getElementById('t')!.firstChild!.nodeValue =
        'NESTED-BEFORE';
      await tick();
      expect(dump(events)).toContain('NESTED-BEFORE');

      outer.classList.add('rr-block');
      inner.contentDocument!.getElementById('t')!.firstChild!.nodeValue = EDIT;
      await tick();
      expect(dump(events)).not.toContain(EDIT);
    });

    it('does not record an unblocked-again iframe until the next full snapshot, then records it', async () => {
      const frame = makeFrame(
        { id: 'f', class: 'rr-block' },
        `<p id="t">${CONTROL}</p>`,
      );
      const events = start();
      await tick();
      expect(dump(events)).not.toContain(CONTROL);

      frame.classList.remove('rr-block');
      await tick();
      frame.contentDocument!.getElementById('t')!.firstChild!.nodeValue = EDIT;
      await tick();
      // existing behaviour for elements that lose their block state: the content joins at the next snapshot
      expect(dump(events)).not.toContain(EDIT);

      record.takeFullSnapshot(true);
      await tick();
      expect(dump(events)).toContain(EDIT);
      frame.contentDocument!.getElementById('t')!.firstChild!.nodeValue =
        'AFTER-RESNAP';
      await tick();
      expect(dump(events)).toContain('AFTER-RESNAP');
    });

    it('observes again after block, unblock and a new full snapshot (no duplicate observers)', async () => {
      const frame = makeFrame({ id: 'f' }, '<p id="t">x</p>');
      const events = start();
      await tick();
      frame.classList.add('rr-block');
      frame.contentDocument!.getElementById('t')!.firstChild!.nodeValue = EDIT;
      await tick();
      frame.classList.remove('rr-block');
      record.takeFullSnapshot(true);
      await tick();
      const mark = events.length;
      frame.contentDocument!.getElementById('t')!.firstChild!.nodeValue =
        'AGAIN';
      await tick();
      const texts = incremental(
        events.slice(mark),
        IncrementalSource.Mutation,
      ).flatMap((e) => (e.data as { texts: Array<{ value: string }> }).texts);
      expect(texts.filter((t) => t.value === 'AGAIN')).toHaveLength(1);
    });
  });

  describe('cross-origin message path (recordCrossOriginIframes: true)', () => {
    const message = (iframe: HTMLIFrameElement) =>
      new MessageEvent('message', {
        data: {
          type: 'rrweb',
          origin: window.location.origin,
          isCheckout: false,
          event: {
            type: EventType.IncrementalSnapshot,
            timestamp: Date.now(),
            data: {
              source: IncrementalSource.Mutation,
              adds: [],
              removes: [],
              attributes: [],
              texts: [{ id: 1, value: SECRET }],
            },
          },
        },
        origin: window.location.origin,
        source: iframe.contentWindow,
      });

    it('accepts an event relayed by a recorded iframe (control)', async () => {
      const frame = makeFrame({ id: 'f', class: 'ok' }, '<p>x</p>');
      const events = start({
        recordCrossOriginIframes: true,
        blockSelector: 'iframe:not(.ok)',
      });
      await tick();
      window.dispatchEvent(message(frame));
      await tick();
      expect(dump(events)).toContain(SECRET);
    });

    it('drops an event relayed by a blocked iframe', async () => {
      const frame = makeFrame({ id: 'f', class: 'rr-block' }, '<p>x</p>');
      const events = start({ recordCrossOriginIframes: true });
      await tick();
      window.dispatchEvent(message(frame));
      await tick();
      expect(dump(events)).not.toContain(SECRET);
    });

    it('drops an event relayed by an iframe that became blocked after it was recorded', async () => {
      const frame = makeFrame({ id: 'f' }, '<p>x</p>');
      const events = start({ recordCrossOriginIframes: true });
      await tick();
      frame.classList.add('rr-block');
      window.dispatchEvent(message(frame));
      await tick();
      expect(dump(events)).not.toContain(SECRET);
    });
  });
});
