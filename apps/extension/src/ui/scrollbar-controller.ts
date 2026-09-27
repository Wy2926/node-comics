import {msg} from '../i18n/runtime';

type Axis = 'x' | 'y';
type Rail = {element: HTMLDivElement; thumb: HTMLSpanElement; length: number; size: number; max: number};
type Entry = {target: HTMLElement; layer: HTMLDivElement; rails: Record<Axis, Rail>; reserveX: boolean; reserveY: boolean; dispose: () => void};
const axes: Axis[] = ['x', 'y'];
const owned = '.nc-scrollbar-layer';
const scrollable = (value: string) => value === 'auto' || value === 'scroll';
let nextId = 0;

/** No wrappers or replacement viewports: virtual lists, selection and saved offsets stay native. */
export function installScrollbars(scope: HTMLElement) {
  const root = document.documentElement, entries = new Map<HTMLElement, Entry>();
  let frame = 0, dirty = true, disposed = false;
  const extent = (target: HTMLElement, axis: Axis) => axis === 'x' ? target.clientWidth : target.clientHeight;
  const maximum = (target: HTMLElement, axis: Axis) => Math.max(0, (axis === 'x' ? target.scrollWidth : target.scrollHeight) - extent(target, axis));
  const rtl = (target: HTMLElement, axis: Axis) => axis === 'x' && getComputedStyle(target).direction === 'rtl';
  const position = (target: HTMLElement, axis: Axis) => axis === 'x' ? target.scrollLeft + (rtl(target, axis) ? maximum(target, axis) : 0) : target.scrollTop;
  function variable(target: HTMLElement, name: string, value: string) {
    if (target.style.getPropertyValue(name) !== value) target.style.setProperty(name, value);
  }
  function background(target: HTMLElement) {
    for (let node: HTMLElement | null = target; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
    }
    return getComputedStyle(root).getPropertyValue('--canvas');
  }
  function move(target: HTMLElement, axis: Axis, value: number) {
    const max = maximum(target, axis), offset = Math.max(0, Math.min(max, value)) - (rtl(target, axis) ? max : 0);
    target.scrollTo({...axis === 'x' ? {left: offset} : {top: offset}, behavior: 'instant'});
  }
  function schedule(rescan = false) {
    if (disposed) return;
    dirty ||= rescan;
    if (!frame) frame = requestAnimationFrame(update);
  }
  function create(target: HTMLElement): Entry {
    const layer = document.createElement('div');
    layer.className = 'nc-scrollbar-layer';
    layer.popover = 'manual';
    const generatedId = !target.id;
    if (generatedId) target.id = `nc-scroll-viewport-${++nextId}`;
    target.classList.add('nc-scrollbar-viewport');
    const rails = {} as Record<Axis, Rail>;
    const preserveFocus = target.matches('textarea,[role=listbox],[role=menu]');
    for (const axis of axes) {
      const element = document.createElement('div'), thumb = document.createElement('span');
      element.className = `nc-scrollbar nc-scrollbar-${axis}${target === root && axis === 'y' ? ' nc-page-scrollbar' : ''}`;
      thumb.className = `nc-scrollbar-thumb${target === root && axis === 'y' ? ' nc-page-scrollbar-thumb' : ''}`;
      element.setAttribute('role', 'scrollbar');
      element.setAttribute('aria-controls', target.id);
      element.setAttribute('aria-orientation', axis === 'x' ? 'horizontal' : 'vertical');
      element.setAttribute('aria-valuemin', '0');
      element.tabIndex = preserveFocus ? -1 : 0;
      element.append(thumb);layer.append(element);
      const rail = rails[axis] = {element, thumb, length: 0, size: 0, max: 0};
      let drag: {pointer: number; coordinate: number; scroll: number} | undefined;
      const coordinate = (event: PointerEvent) => axis === 'x' ? event.clientX : event.clientY;
      element.onpointerdown = event => {
        if (event.button !== 0 || !event.isPrimary || rail.length <= rail.size) return;
        event.preventDefault();event.stopPropagation();
        if (!preserveFocus) element.focus({preventScroll: true});
        const rect = element.getBoundingClientRect(), at = coordinate(event) - (axis === 'x' ? rect.left : rect.top);
        const scroll = position(target, axis), offset = scroll / rail.max * (rail.length - rail.size);
        if (at < offset || at > offset + rail.size) move(target, axis, (at - rail.size / 2) / (rail.length - rail.size) * rail.max);
        drag = {pointer: event.pointerId, coordinate: coordinate(event), scroll: position(target, axis)};
        element.setPointerCapture(event.pointerId);element.dataset.dragging = 'true';
      };
      element.onpointermove = event => {
        if (!drag || event.pointerId !== drag.pointer || rail.length <= rail.size) return;
        move(target, axis, drag.scroll + (coordinate(event) - drag.coordinate) / (rail.length - rail.size) * rail.max);
      };
      const end = (event: PointerEvent) => {
        if (event.pointerId !== drag?.pointer) return;
        drag = undefined;delete element.dataset.dragging;
        if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      };
      element.onpointerup = end;element.onpointercancel = end;element.onlostpointercapture = end;
      element.onkeydown = event => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const scroll = position(target, axis), page = rail.length * .9;
        const arrow = axis === 'x' ? {ArrowLeft: scroll - 40, ArrowRight: scroll + 40} : {ArrowUp: scroll - 40, ArrowDown: scroll + 40};
        const keys: Record<string, number | undefined> = {...arrow, PageDown: scroll + page, PageUp: scroll - page, Home: 0, End: rail.max, ' ': scroll + (event.shiftKey ? -page : page)};
        const next = keys[event.key];
        if (next === undefined) return;
        event.preventDefault();event.stopPropagation();move(target, axis, next);
      };
    }
    layer.onclick = event => event.stopPropagation();
    layer.addEventListener('wheel', event => {
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? target.clientHeight : 1;
      const x = (event.shiftKey ? event.deltaY : event.deltaX) * scale, y = (event.shiftKey ? 0 : event.deltaY) * scale;
      // Wheel events on a top-layer rail must still use its original nested scroll chain.
      let node: HTMLElement | null = target;
      while (node) {
        const beforeX = node.scrollLeft, beforeY = node.scrollTop;
        const style = getComputedStyle(node);
        node.scrollBy({left: node === root || scrollable(style.overflowX) ? x : 0, top: node === root || scrollable(style.overflowY) ? y : 0, behavior: 'instant'});
        if (node.scrollLeft !== beforeX || node.scrollTop !== beforeY || (y && style.overscrollBehaviorY !== 'auto') || (x && style.overscrollBehaviorX !== 'auto')) break;
        node = node.parentElement;
      }
      event.preventDefault();event.stopPropagation();
    }, {passive: false});
    return {target, layer, rails, reserveX: false, reserveY: false, dispose() {
      layer.remove();target.classList.remove('nc-scrollbar-viewport');
      delete target.dataset.ncScrollbarMode;
      for (const property of ['--nc-scrollbar-padding-right','--nc-scrollbar-padding-bottom','--nc-scrollbar-reserve-x','--nc-scrollbar-reserve-y']) target.style.removeProperty(property);
      if (generatedId) target.removeAttribute('id');
    }};
  }

  const observed = new Set<Element>();
  const resize = new ResizeObserver(() => schedule(true));
  function reconcile() {
    const targets = new Set<HTMLElement>([root]);
    for (const element of [scope, ...scope.querySelectorAll<HTMLElement>('*')]) {
      if (!(element instanceof HTMLElement) || element.closest(owned)) continue;
      const style = getComputedStyle(element);
      if (scrollable(style.overflowX) || scrollable(style.overflowY)) targets.add(element);
    }
    for (const [target, entry] of entries) if (!targets.has(target)) {entry.dispose();entries.delete(target);}
    for (const target of targets) if (!entries.has(target)) entries.set(target, create(target));
    // Measure authored padding without our gutter, in one synchronous layout pass.
    // Remember used axes so hiding a bar does not repeatedly reflow its contents.
    root.classList.add('nc-scrollbars-measuring');
    const padding = [...entries.values()].map(entry => {
      const {target} = entry, style = getComputedStyle(target);
      const mode = target === root ? scope.querySelector('[data-page-scrollbar-mode]')?.getAttribute('data-page-scrollbar-mode') ?? 'overlay' : target.dataset.scrollbarMode ?? 'reserved';
      entry.reserveX ||= maximum(target, 'x') > 1;
      entry.reserveY ||= maximum(target, 'y') > 1 || target === root && mode === 'reserved';
      return {entry, mode, right: style.paddingRight, bottom: style.paddingBottom};
    });
    for (const {entry, mode, right, bottom} of padding) {
      const {target} = entry;
      target.dataset.ncScrollbarMode = mode;
      variable(target, '--nc-scrollbar-padding-right', right);
      variable(target, '--nc-scrollbar-padding-bottom', bottom);
      variable(target, '--nc-scrollbar-reserve-x', entry.reserveX ? '20px' : '0px');
      variable(target, '--nc-scrollbar-reserve-y', entry.reserveY ? '20px' : '0px');
    }
    root.classList.remove('nc-scrollbars-measuring');
    const wanted = new Set<Element>([scope, root, document.body]);
    for (const target of targets) {
      wanted.add(target);
      for (const child of target.children) if (!child.matches(owned)) wanted.add(child);
    }
    for (const element of observed) if (!wanted.has(element)) {resize.unobserve(element);observed.delete(element);}
    for (const element of wanted) if (!observed.has(element)) {resize.observe(element);observed.add(element);}
  }
  function update() {
    frame = 0;
    if (dirty) {dirty = false;reconcile();}
    const modal = [...scope.querySelectorAll<HTMLDialogElement>('dialog:modal')].at(-1);
    const headerHeight = scope.querySelector('.nc-app-header')?.getBoundingClientRect().height ?? 0;
    const padding = `${headerHeight}px`;
    if (root.style.getPropertyValue('--nc-header-height') !== padding) root.style.setProperty('--nc-header-height', padding);
    for (const entry of entries.values()) {
      const {target, layer, rails} = entry;
      const page = target === root, style = getComputedStyle(target);
      const parent = page ? scope : target.closest<HTMLElement>('dialog,[popover]:not(.nc-scrollbar-layer)') ?? scope;
      if (layer.parentElement !== parent) parent.append(layer);
      let visible = target.dataset.ncScrollbarMode !== 'hidden' && target.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) && !target.closest('[inert]') && (!modal || modal.contains(target));
      const bounds = target.getBoundingClientRect();
      let left = page ? 0 : bounds.left + target.clientLeft, top = page ? headerHeight : bounds.top + target.clientTop;
      let right = page ? root.clientWidth : left + target.clientWidth, bottom = page ? root.clientHeight : top + target.clientHeight;
      // Clip rails along with their scroll owner, including nested scrollers and the sticky masthead.
      if (!page) {
        let ancestor = target.parentElement;
        const topLayer = target.closest('dialog:modal,[popover]:popover-open');
        while (ancestor && !target.matches('dialog:modal,[popover]:popover-open')) {
          const clip = getComputedStyle(ancestor), rect = ancestor.getBoundingClientRect();
          if (clip.overflowX !== 'visible') {left = Math.max(left, rect.left + ancestor.clientLeft);right = Math.min(right, rect.left + ancestor.clientLeft + ancestor.clientWidth);}
          if (clip.overflowY !== 'visible') {top = Math.max(top, rect.top + ancestor.clientTop);bottom = Math.min(bottom, rect.top + ancestor.clientTop + ancestor.clientHeight);}
          if (ancestor === topLayer) break;
          ancestor = ancestor.parentElement;
        }
        left = Math.max(0, left);right = Math.min(root.clientWidth, right);
        top = Math.max(topLayer ? 0 : headerHeight, top);bottom = Math.min(root.clientHeight, bottom);
      }
      visible &&= right - left > 20 && bottom - top > 20;
      const maxX = scrollable(style.overflowX) || page ? maximum(target, 'x') : 0;
      const maxY = scrollable(style.overflowY) || page ? maximum(target, 'y') : 0;
      if (target.dataset.ncScrollbarMode === 'reserved' && (maxX > 1 && !entry.reserveX || maxY > 1 && !entry.reserveY)) {
        entry.reserveX ||= maxX > 1;entry.reserveY ||= maxY > 1;schedule(true);
      }
      visible &&= maxX > 1 || maxY > 1;
      if (!visible) {if (layer.matches(':popover-open')) layer.hidePopover();continue;}
      layer.style.cssText = `left:${left}px;top:${top}px;width:${right-left}px;height:${bottom-top}px`;
      layer.dataset.compact = String(bottom - top < 48);
      layer.dataset.mode = target.dataset.ncScrollbarMode;
      variable(layer, '--nc-scrollbar-reserve-x', style.getPropertyValue('--nc-scrollbar-reserve-x'));
      variable(layer, '--nc-scrollbar-reserve-y', style.getPropertyValue('--nc-scrollbar-reserve-y'));
      variable(layer, '--nc-scrollbar-background', background(target));
      let any = false;
      for (const axis of axes) {
        const rail = rails[axis], max = axis === 'x' ? maxX : maxY;
        rail.max = max;
        rail.length = Math.max(0, (axis === 'x' ? right - left : bottom - top) - 16 - ((axis === 'x' ? maxY : maxX) > 1 ? 14 : 0));
        rail.size = Math.min(rail.length, Math.max(32, rail.length * extent(target, axis) / (max + extent(target, axis))));
        const scroll = Math.max(0, Math.min(max, position(target, axis)));
        const x = axis === 'x' ? (left + right) / 2 : right - 10, y = axis === 'y' ? (top + bottom) / 2 : bottom - 10;
        const hit = document.elementsFromPoint(x, y).find(element => !element.closest(owned));
        const occluded = hit && (page ? !!hit.closest('dialog:modal,[popover]:popover-open') : !target.contains(hit));
        rail.element.hidden = max <= 1 || rail.length <= rail.size || !!occluded;
        any ||= !rail.element.hidden;
        rail.element.style[axis === 'x' ? 'width' : 'height'] = `${rail.length}px`;
        rail.thumb.style[axis === 'x' ? 'width' : 'height'] = `${rail.size}px`;
        rail.thumb.style.transform = `translate${axis.toUpperCase()}(${max ? scroll / max * (rail.length - rail.size) : 0}px)`;
        rail.element.setAttribute('aria-label', target.getAttribute('aria-label') || msg('页面滚动'));
        rail.element.setAttribute('aria-valuemax', String(Math.round(max)));
        rail.element.setAttribute('aria-valuenow', String(Math.round(scroll)));
      }
      if (any && !layer.matches(':popover-open')) layer.showPopover();
      else if (!any && layer.matches(':popover-open')) layer.hidePopover();
    }
  }
  const mutation = new MutationObserver(records => {
    if (records.some(record => !(record.target instanceof Element ? record.target : record.target.parentElement)?.closest(owned)
      && (record.type !== 'childList' || [...record.addedNodes, ...record.removedNodes].some(node => !(node instanceof Element && node.matches(owned)))))) schedule(true);
  });
  mutation.observe(scope, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class','style','hidden','open','inert','value','data-page-scrollbar-mode','data-scrollbar-mode']});
  const scroll = () => schedule(), changed = () => schedule(true);
  const toggle = (event: Event) => {if (!(event.target instanceof Element && event.target.closest(owned))) schedule(true);};
  document.addEventListener('scroll', scroll, true);
  scope.addEventListener('toggle', toggle, true);
  scope.addEventListener('input', changed, true);
  scope.addEventListener('load', changed, true);
  scope.addEventListener('transitionend', changed, true);
  window.addEventListener('resize', changed);
  update();
  return () => {
    disposed = true;cancelAnimationFrame(frame);mutation.disconnect();resize.disconnect();
    document.removeEventListener('scroll', scroll, true);scope.removeEventListener('toggle', toggle, true);
    scope.removeEventListener('input', changed, true);scope.removeEventListener('load', changed, true);
    scope.removeEventListener('transitionend', changed, true);window.removeEventListener('resize', changed);
    for (const entry of entries.values()) entry.dispose();
    root.style.removeProperty('--nc-header-height');
  };
}
