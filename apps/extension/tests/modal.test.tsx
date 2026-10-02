import {describe, expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {Modal} from '../src/ui/components';

describe('shared Modal presentation', () => {
  it('keeps the close control outside the independently focusable scroll body', () => {
    const html = renderToStaticMarkup(<Modal title="Example dialog" subtitle="Long description" onClose={() => {}}><form><input aria-label="Example field"/><button>Submit</button></form></Modal>);
    expect(html).toMatch(/<dialog\b[^>]*class="modal nc-generic-modal /);
    expect(html).toContain('aria-label="Example dialog"');
    const controls = html.match(/<div class="nc-modal-controls">(.*?)<\/div>/)?.[1];
    expect(controls).toContain('class="modal-close icon-button"');
    expect(controls).toContain('type="button"');
    expect(controls).not.toContain('<form');
    expect(html).toMatch(/<div class="nc-modal-body" tabindex="0"><h2>Example dialog<\/h2><p class="modal-subtitle">Long description<\/p><form>/);
    expect(html).not.toContain('<dialog open');
  });

  it('retains consumer classes, custom close labels and optional subtitles', () => {
    const html = renderToStaticMarkup(<Modal title="Import result" className="nc-local-import-modal" closeLabel="Collapse import" onClose={() => {}}><footer className="nc-import-footer">Done</footer></Modal>);
    expect(html).toContain('class="modal nc-generic-modal nc-local-import-modal"');
    expect(html).toContain('aria-label="Collapse import"');
    expect(html).toContain('<footer class="nc-import-footer">Done</footer></div></dialog>');
    expect(html).not.toContain('modal-subtitle');
  });
});
