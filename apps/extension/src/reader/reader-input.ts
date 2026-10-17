export const READER_INTERACTIVE='a,button,input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[role="slider"],[role="textbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="spinbutton"],[role="searchbox"],[role="listbox"],[role="treeitem"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[data-no-swipe]';

/** One click policy for all layouts; paging only decides which reading action follows. */
export function ignoreReaderClick(event:Pick<MouseEvent,'defaultPrevented'|'button'|'altKey'|'ctrlKey'|'metaKey'|'shiftKey'|'target'>):boolean{
 return event.defaultPrevented||event.button!==0||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||
  !!(event.target as Element|null)?.closest?.(READER_INTERACTIVE)||!!window.getSelection?.()?.toString();
}
