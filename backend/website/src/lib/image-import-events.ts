/** Page-wide image inputs; text editing and handled drop-zone events stay untouched. */
export function bindImageImport(root: Document, add: (files: File[]) => void) {
  function paste(event: ClipboardEvent) {
    if (event.defaultPrevented || (event.target instanceof Element &&
      event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'))) return;
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length) { event.preventDefault(); add(files); }
  }
  function dragOver(event: DragEvent) {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  }
  function drop(event: DragEvent) {
    if (event.defaultPrevented || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    add(Array.from(event.dataTransfer.files));
  }
  root.addEventListener('paste', paste);
  root.addEventListener('dragover', dragOver);
  root.addEventListener('drop', drop);
  return () => {
    root.removeEventListener('paste', paste);
    root.removeEventListener('dragover', dragOver);
    root.removeEventListener('drop', drop);
  };
}
