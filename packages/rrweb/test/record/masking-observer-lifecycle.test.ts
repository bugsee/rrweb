/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EventType, IncrementalSource, type eventWithTime } from '@rrweb/types';
import { record } from '../../src';

// rrweb 2.2.0 reworked how the recorder re-observes shadow roots and same-origin iframe documents (observers
// are now released on removal/unload and created again when the host/iframe comes back). Every one of those
// re-observation paths must go on honouring the Bugsee masking options, or a value the page shows or the user
// types after the re-attach would be recorded in the clear. Annotations are the one new event the recorder
// can emit; they carry caller-supplied text only, never page content.

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const SECRET = 'TOP-SECRET-VALUE';
const MASKED = '*'.repeat(SECRET.length);

// Not vacuous: the masked form must be PRESENT (the node/value really was recorded) and the clear text absent.
const expectOnlyMasked = (events: eventWithTime[]) => {
  const text = JSON.stringify(events);
  expect(text).toContain(MASKED);
  expect(text).not.toContain(SECRET);
};

const mutationTexts = (events: eventWithTime[]) =>
  events
    .filter(
      (e) =>
        e.type === EventType.IncrementalSnapshot &&
        e.data.source === IncrementalSource.Mutation,
    )
    .flatMap((e) =>
      (e.data as { texts: Array<{ value: string | null }> }).texts.map(
        (t) => t.value,
      ),
    );

const addedTextNodes = (events: eventWithTime[]) => {
  const out: string[] = [];
  const walk = (n: {
    type?: number;
    textContent?: string;
    childNodes?: unknown[];
  }) => {
    if (n.type === 3 && typeof n.textContent === 'string')
      out.push(n.textContent);
    (n.childNodes ?? []).forEach((c) => walk(c as typeof n));
  };
  for (const e of events) {
    if (
      e.type === EventType.IncrementalSnapshot &&
      e.data.source === IncrementalSource.Mutation
    ) {
      (e.data as { adds: Array<{ node: object }> }).adds.forEach((a) =>
        walk(a.node),
      );
    }
  }
  return out;
};

const inputTexts = (events: eventWithTime[]) =>
  events
    .filter(
      (e) =>
        e.type === EventType.IncrementalSnapshot &&
        e.data.source === IncrementalSource.Input,
    )
    .map((e) => (e.data as { text: string }).text);

describe('masking survives the 2.2.0 observer re-attachment paths', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
    document.body.innerHTML = '';
  });

  const start = (extra: Record<string, unknown> = {}) => {
    const events: eventWithTime[] = [];
    stop = record({
      emit: (event) => events.push(event),
      maskAllInputs: true,
      maskAllText: true,
      ...extra,
    } as Parameters<typeof record>[0]);
    return events;
  };

  it('masks text added to a shadow root that is attached again after its host was removed', async () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<p>first</p>';
    document.body.appendChild(host);
    const events = start();
    await tick();

    // 2.2.0 releases the shadow root's observer when the host leaves the DOM...
    host.remove();
    await tick();
    // ...and observes it afresh when the same host is put back.
    document.body.appendChild(host);
    await tick();
    const late = document.createElement('p');
    late.textContent = SECRET;
    root.appendChild(late);
    await tick();

    expect(addedTextNodes(events).length).toBeGreaterThan(0);
    expectOnlyMasked(events);
  });

  it('masks text edited inside a shadow root observed since the snapshot', async () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<p id="t">hello</p>';
    document.body.appendChild(host);
    const events = start();
    await tick();
    (root.getElementById('t') as HTMLElement).firstChild!.nodeValue = SECRET;
    await tick();

    expect(mutationTexts(events)).toContain(MASKED);
    expectOnlyMasked(events);
  });

  it('masks text added to a shadow root created inside a removed-then-restored subtree', async () => {
    const wrapper = document.createElement('section');
    const host = document.createElement('div');
    wrapper.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    document.body.appendChild(wrapper);
    const events = start();
    await tick();

    wrapper.remove();
    await tick();
    document.body.appendChild(wrapper);
    await tick();
    const late = document.createElement('p');
    late.textContent = SECRET;
    root.appendChild(late);
    await tick();

    expect(addedTextNodes(events)).toContain(MASKED);
    expectOnlyMasked(events);
  });

  it('masks a value typed into an input inside a shadow root', async () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<input id="i" type="text">';
    document.body.appendChild(host);
    const events = start();
    await tick();
    const input = root.getElementById('i') as HTMLInputElement;
    input.value = SECRET;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await tick();

    expect(inputTexts(events)).toEqual([MASKED]);
    expectOnlyMasked(events);
  });

  it('masks text and typed values in a same-origin iframe document that is observed once', async () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const idoc = iframe.contentDocument!;
    idoc.body.innerHTML = '<p id="t">visible</p><input id="i" type="text">';
    const events = start({ recordCrossOriginIframes: false });
    await tick();
    // A second full snapshot attaches the iframe again; 2.2.0 must not observe its document a second time
    // and must not drop the masking options on the observer it keeps.
    record.takeFullSnapshot(true);
    await tick();

    (idoc.getElementById('t') as HTMLElement).firstChild!.nodeValue = SECRET;
    const input = idoc.getElementById('i') as HTMLInputElement;
    input.value = SECRET;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();

    expectOnlyMasked(events);
    expect(inputTexts(events)).toEqual([MASKED]);
    expect(mutationTexts(events)).toContain(MASKED);
  });

  it('masks an input value set through the value attribute inside a re-observed shadow root', async () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<input id="i" type="text">';
    document.body.appendChild(host);
    const events = start();
    await tick();
    host.remove();
    await tick();
    document.body.appendChild(host);
    await tick();
    (root.getElementById('i') as HTMLInputElement).setAttribute(
      'value',
      SECRET,
    );
    await tick();

    expectOnlyMasked(events);
  });

  it('keeps an explicitly unmasked element readable on the re-observed shadow path (selectors still apply)', async () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
    const events = start({ unmaskTextSelector: '.ok' });
    await tick();
    host.remove();
    await tick();
    document.body.appendChild(host);
    await tick();
    const open = document.createElement('p');
    open.className = 'ok';
    open.textContent = 'public-label';
    const closed = document.createElement('p');
    closed.textContent = SECRET;
    root.append(open, closed);
    await tick();

    const text = JSON.stringify(events);
    expect(text).toContain('public-label');
    expect(text).not.toContain(SECRET);
  });
});

describe('record.addAnnotation (new in 2.2.0)', () => {
  it('throws before recording starts, so nothing is emitted outside a session', () => {
    expect(() =>
      record.addAnnotation({ type: 'timelineMarker', text: 'x' }),
    ).toThrow(/after recording started/);
  });

  it('emits exactly the caller-supplied annotation and nothing derived from the page', async () => {
    document.body.innerHTML = `<p>${SECRET}</p><input type="text" value="${SECRET}">`;
    const events: eventWithTime[] = [];
    const stopFn = record({
      emit: (e) => events.push(e),
      maskAllInputs: true,
      maskAllText: true,
    });
    record.addAnnotation({ type: 'caption', text: 'checkout started' });
    await tick();
    stopFn?.();
    document.body.innerHTML = '';

    const annotations = events.filter((e) => e.type === EventType.Annotation);
    expect(annotations).toHaveLength(1);
    expect((annotations[0] as { data: unknown }).data).toEqual({
      type: 'caption',
      text: 'checkout started',
    });
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
});
