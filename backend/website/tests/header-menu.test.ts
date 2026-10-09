import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindHeaderMenus } from '../src/lib/header-menu';

test('header menus preserve internal focus and dismiss outside focus, pointer and Escape', () => {
  class ElementStub extends EventTarget {
    open = true;
    focused = false;
    children: ElementStub[] = [];
    contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
    querySelector() { return this.children[0]; }
    focus() { this.focused = true; }
  }
  const previous = globalThis.Node;
  Object.assign(globalThis, { Node: ElementStub });
  const root = new EventTarget();
  const menu = new ElementStub(), summary = new ElementStub(), link = new ElementStub();
  menu.children = [summary, link];
  Object.assign(root, { querySelectorAll: () => [menu] });
  const dispatch = (target: EventTarget, type: string, properties: object) => {
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries(properties)) Object.defineProperty(event, key, { value });
    target.dispatchEvent(event);
    return event;
  };
  try {
    bindHeaderMenus(root as unknown as Document);
    dispatch(menu, 'focusout', { relatedTarget: link });
    dispatch(root, 'focusin', { target: link });
    assert.equal(menu.open, true);
    dispatch(root, 'pointerdown', { target: link });
    assert.equal(menu.open, true);
    // WebKit blurs the summary without focusing the tapped link before click.
    dispatch(menu, 'focusout', { relatedTarget: null });
    assert.equal(menu.open, true, 'a link tap must remain clickable after focus is lost');
    dispatch(link, 'click', {});
    assert.equal(menu.open, true);
    assert.equal(dispatch(menu, 'keydown', { key: 'Escape' }).defaultPrevented, true);
    assert.equal(menu.open, false);
    assert.equal(summary.focused, true);
    menu.open = true;
    dispatch(root, 'pointerdown', { target: new ElementStub() });
    assert.equal(menu.open, false);
    menu.open = true;
    dispatch(root, 'focusin', { target: new ElementStub() });
    assert.equal(menu.open, false);
  } finally { Object.assign(globalThis, { Node: previous }); }
});
