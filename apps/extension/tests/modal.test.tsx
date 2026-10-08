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
    const classes = html.match(/<dialog\b[^>]*class="([^"]+)"/)?.[1].split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['modal', 'nc-generic-modal', 'nc-viewport-dialog', 'nc-local-import-modal']));
    expect(html).toContain('aria-label="Collapse import"');
    expect(html).toContain('<footer class="nc-import-footer">Done</footer></div></dialog>');
    expect(html).not.toContain('modal-subtitle');
    expect(html).not.toContain('nc-modal-actions');
  });

  it('keeps an optional action footer outside the scroll body without duplicating the form', () => {
    const html = renderToStaticMarkup(<Modal title="Connect channel" onClose={() => {}} footer={<footer><button type="submit" form="channel-form">Connect</button></footer>}>
      <form id="channel-form"><input aria-label="Channel name"/></form>
    </Modal>);
    const body = html.match(/<div class="nc-modal-body"[^>]*>([\s\S]*?)<\/div><div class="nc-modal-actions">/)?.[1];
    expect(body).toContain('<form id="channel-form">');
    expect(body).not.toContain('<footer');
    expect(body).not.toContain('>Connect</button>');
    expect(html).toContain('<div class="nc-modal-actions"><footer><button type="submit" form="channel-form">Connect</button></footer></div></dialog>');
    expect(html.match(/<form\b/g)).toHaveLength(1);
    expect(html.match(/<input\b/g)).toHaveLength(1);
    expect(html.match(/>Connect<\/button>/g)).toHaveLength(1);
  });
});
