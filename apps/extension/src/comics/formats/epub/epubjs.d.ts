declare module "epubjs/src/book.js" {
  export { default } from "epubjs/types/book";
}
declare module "epubjs/src/packaging.js" {
  export { default } from "epubjs/types/packaging";
}
declare module "epubjs/src/navigation.js" {
  export { default } from "epubjs/types/navigation";
}
declare module "epubjs/src/managers/views/iframe.js" {
  import View from 'epubjs/types/managers/view';
  import Contents from 'epubjs/types/contents';
  import Section from 'epubjs/types/section';
  export default class IframeView extends View {
    section: Section;
    contents?: Contents;
    element: HTMLElement;
    layout: {name: string; columnWidth: number; height: number; divisor: number};
    sectionRender?: Promise<string>;
    expand(force?: boolean): void;
  }
}
declare module 'epubjs/src/managers/continuous/index.js' {
  export default class ContinuousViewManager {
    constructor(options: unknown);
    settings: {axis: string; direction: string};
    container?: HTMLElement;
    scrollTop: number;
    scrollLeft: number;
    q: {stop(): void};
    ignore: boolean;
    trimTimeout?: ReturnType<typeof setTimeout>;
    scrollTimeout?: ReturnType<typeof setTimeout>;
    afterScrolled?: ReturnType<typeof setTimeout>;
    _scrolled?: (() => void) & {cancel(): void};
    check(left?: number, top?: number): Promise<unknown>;
    fill(): Promise<void>;
    next(): void;
    prev(): void;
    onScroll(): void;
    destroy(): void;
  }
}
