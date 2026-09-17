/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EventType, IncrementalSource, type eventWithTime } from '@rrweb/types';
import { record } from '../../src';

// `unmaskInputSelector` opts an input out of value masking. It used to reach the FULL SNAPSHOT only: a value
// the user typed while recording (the input observer), and a value set later through the `value`
// attribute or a `<textarea>`'s text (the mutation observer), stayed masked on an unmasked input. Every
// path now resolves the value one way (rrweb-snapshot `resolveInputValue`), and none of them un-masks a
// sensitive input.

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('record — unmaskInputSelector on every value path', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
    document.body.innerHTML = '';
  });

  const start = () => {
    const events: eventWithTime[] = [];
    stop = record({
      emit: (event) => events.push(event),
      maskAllInputs: true,
      unmaskInputSelector: '.bugsee-unmask',
    });
    return events;
  };

  const inputValues = (events: eventWithTime[]) =>
    events
      .filter(
        (e) =>
          e.type === EventType.IncrementalSnapshot &&
          e.data.source === IncrementalSource.Input,
      )
      .map((e) => (e.data as { text: string }).text);

  const attributeValues = (events: eventWithTime[]) =>
    events
      .filter(
        (e) =>
          e.type === EventType.IncrementalSnapshot &&
          e.data.source === IncrementalSource.Mutation,
      )
      .flatMap((e) =>
        (e.data as { attributes: Array<{ attributes: Record<string, unknown> }> }).attributes,
      )
      .map((a) => a.attributes.value)
      .filter((v) => v !== undefined);

  const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('records the real typed value of an unmasked input, and masks the others', async () => {
    document.body.innerHTML = `
      <input id="open" type="text" class="bugsee-unmask">
      <input id="closed" type="text">`;
    const events = start();
    type(document.getElementById('open') as HTMLInputElement, 'hello');
    type(document.getElementById('closed') as HTMLInputElement, 'world');
    await tick();
    expect(inputValues(events)).toEqual(['hello', '*****']);
  });

  it.each([
    ['a password field', '<input id="f" type="password" class="bugsee-unmask">'],
    ['a credit-card field', '<input id="f" type="text" autocomplete="cc-number" class="bugsee-unmask">'],
  ])('never records the typed value of %s, even when unmasked', async (_label, html) => {
    document.body.innerHTML = html;
    const events = start();
    type(document.getElementById('f') as HTMLInputElement, '4242');
    await tick();
    expect(inputValues(events)).toEqual(['****']);
  });

  it('records a value set through the value ATTRIBUTE of an unmasked input as-is', async () => {
    document.body.innerHTML = `
      <input id="open" type="text" class="bugsee-unmask">
      <input id="closed" type="text">`;
    const events = start();
    await tick();
    document.getElementById('open')!.setAttribute('value', 'visible');
    document.getElementById('closed')!.setAttribute('value', 'hidden');
    await tick();
    expect(attributeValues(events)).toEqual(['visible', '******']);
  });

  it('records the text of an unmasked <textarea> changed while recording', async () => {
    document.body.innerHTML = `
      <textarea id="open" class="bugsee-unmask">a</textarea>
      <textarea id="closed">b</textarea>`;
    const events = start();
    await tick();
    document.getElementById('open')!.textContent = 'notes';
    document.getElementById('closed')!.textContent = 'diary';
    await tick();
    expect(attributeValues(events)).toEqual(['notes', '*****']);
  });

  it('keeps a sensitive field masked on the attribute path too', async () => {
    document.body.innerHTML = '<input id="f" type="password" class="bugsee-unmask">';
    const events = start();
    await tick();
    document.getElementById('f')!.setAttribute('value', 'hunter2');
    await tick();
    expect(attributeValues(events)).toEqual(['*******']);
  });
});
