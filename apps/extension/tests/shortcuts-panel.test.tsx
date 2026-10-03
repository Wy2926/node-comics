import {beforeEach, describe, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ShortcutOverrides} from '../src/shortcuts/catalog';
import {ShortcutPanel} from '../src/ui/shortcuts/ShortcutPanel';
import {ShortcutBindingControl} from '../src/ui/shortcuts/ShortcutBindingControl';

const preferences = vi.hoisted(() => ({
  ready: true, error: false, overrides: {} as ShortcutOverrides, save: vi.fn(),
}));
vi.mock('../src/shortcuts/react', () => ({useShortcutPreferences: () => preferences}));

beforeEach(() => {
  Object.assign(preferences, {ready: true, error: false, overrides: {}});
  preferences.save.mockClear();
});

describe('shortcut preference panel presentation', () => {
  it('keeps all four command groups in one scroll surface and uses the sidebar only for anchors', () => {
    const html = renderToStaticMarkup(<ShortcutPanel initialScope="reader" onClose={() => {}}/>);
    expect(html).toContain('aria-label="快捷键范围"');
    expect(html).toMatch(/<nav\b[^>]*class="nc-shortcut-nav"/);
    expect(html.match(/<button\b[^>]*class="nc-shortcut-anchor"/g)).toHaveLength(4);
    const navigation = html.match(/<nav\b[\s\S]*?<\/nav>/)?.[0];
    expect(navigation).toContain('nc-shortcut-nav-title');
    expect(navigation).toContain('nc-shortcut-anchor-label');
    expect(navigation).not.toContain('nc-shortcut-count');
    const sections = [...html.matchAll(/<section\b[^>]*>/g)].map(([tag]) => tag).filter(tag => tag.includes('nc-shortcut-group'));
    expect(sections).toHaveLength(4);
    for (const scope of ['global', 'app', 'reader', 'web']) {
      const section = sections.find(tag => tag.includes(`data-shortcut-scope="${scope}"`));
      expect(section).toBeDefined();
      const id = section!.match(/\bid="([^"]+)"/)?.[1];
      expect(id).toBeTruthy();
      expect(html).toContain(`aria-controls="${id}"`);
    }
    expect(html.match(/aria-current="location"/g)).toHaveLength(1);
    expect(html).not.toContain('>全部</button>');
    expect(html).toContain('nc-shortcut-scroll');
    expect(html).toContain('nc-shortcut-group-body');
    expect(html).toContain('role="group" aria-label="下一页"');
    expect(html).toContain('nc-shortcut-assignment');
    expect(html).toContain('Page Up');
    expect(html).toContain('Page Down');
    expect(html).toContain('本章首页');
    expect(html).toContain('本章末页');
    expect(html).toContain('随读预翻译后续页面');
    expect(html).toContain('暂停或继续网页翻译');
    expect(html).toContain('导入漫画');
    expect(preferences.save).not.toHaveBeenCalled();
  });

  it('uses a dedicated dialog shell with a separate fixed header, close control and footer', () => {
    const html = renderToStaticMarkup(<ShortcutPanel initialScope="global" onClose={() => {}}/>);
    const dialog = html.match(/<dialog\b[^>]*>/)?.[0];
    expect(dialog).toContain('class="nc-shortcut-panel"');
    expect(dialog).not.toMatch(/class="[^"]*\bmodal\b/);
    expect(html).toMatch(/<header\b[^>]*class="nc-shortcut-header"/);
    expect(html).toMatch(/<button\b[^>]*class="[^"]*nc-shortcut-close/);
    expect(html).toMatch(/<footer\b[^>]*class="nc-shortcut-footer"/);
    expect(html).toMatch(/class="nc-shortcut-scroll"[^>]*tabindex="0"|tabindex="0"[^>]*class="nc-shortcut-scroll"/);
    expect(html).toContain('data-shortcut-scope="reader"');
    expect(html).toContain('data-shortcut-scope="web"');
  });

  it('shows assigned alternatives and an explicitly unassigned command without silently saving', () => {
    preferences.overrides = {'reader.next': ['Ctrl+Alt+KeyN'], 'reader.previous': []};
    const html = renderToStaticMarkup(<ShortcutPanel initialScope="reader" onClose={() => {}}/>);
    expect(html).toContain('aria-description="Ctrl + Alt + N"');
    expect(html).toMatch(/<kbd\b[^>]*>Ctrl<\/kbd>/);
    expect(html).toMatch(/<kbd\b[^>]*>Alt<\/kbd>/);
    expect(html).toMatch(/<kbd\b[^>]*>N<\/kbd>/);
    expect(html).not.toContain('Page Down');
    expect(html).not.toContain('Page Up');
    expect(html).toContain('尚未设置');
    expect(html).toContain('添加“上一页”的快捷键');
    expect(html).toContain('移除“下一页 · Ctrl + Alt + N”的快捷键');
    expect(html).not.toContain('快捷键已保存');
    expect(preferences.save).not.toHaveBeenCalled();
  });

  it('keeps a compact alternative icon-only but exposes its action through accessible name and title', () => {
    const callbacks = {onStart: vi.fn(), onStop: vi.fn(), onRecord: vi.fn(), onRemove: vi.fn()};
    const compact = renderToStaticMarkup(<ShortcutBindingControl label="查看原图" compact recording={false} disabled={false} {...callbacks}/>);
    expect(compact).toContain('class="nc-shortcut-binding is-empty is-compact"');
    expect(compact).toContain('aria-label="添加“查看原图”的快捷键"');
    expect(compact).toContain('title="添加“查看原图”的快捷键"');
    expect(compact).toContain('<svg');
    expect(compact).not.toContain('添加快捷键');
    expect(compact).not.toContain('nc-shortcut-remove');
    expect(compact).not.toContain('tabindex="-1"');
    const unassigned = renderToStaticMarkup(<ShortcutBindingControl label="查看原图" recording={false} disabled={false} {...callbacks}/>);
    expect(unassigned).toContain('添加快捷键');
    expect(unassigned).not.toContain('is-compact');
  });

  it('keeps recording and clearing as separately named native buttons within the same assigned binding', () => {
    const callbacks = {onStart: vi.fn(), onStop: vi.fn(), onRecord: vi.fn(), onRemove: vi.fn()};
    const assigned = renderToStaticMarkup(<ShortcutBindingControl label="查看原图" binding="Ctrl+Alt+KeyU" recording={false} disabled={false} {...callbacks}/>);
    expect(assigned).toMatch(/^<div class="nc-shortcut-binding">/);
    expect(assigned.match(/<button\b/g)).toHaveLength(2);
    expect(assigned).toContain('aria-label="修改“查看原图”的快捷键"');
    expect(assigned).toContain('aria-description="Ctrl + Alt + U"');
    expect(assigned).toContain('aria-label="移除“查看原图 · Ctrl + Alt + U”的快捷键"');
    expect(assigned).toContain('title="移除“查看原图 · Ctrl + Alt + U”的快捷键"');
    expect(assigned).not.toContain('tabindex="-1"');
    const recording = renderToStaticMarkup(<ShortcutBindingControl label="查看原图" binding="KeyO" recording disabled={false} describedBy="recording-hint validation" invalid {...callbacks}/>);
    expect(recording).toContain('class="nc-shortcut-binding is-recording"');
    expect(recording).toContain('aria-describedby="recording-hint validation"');
    expect(recording).toContain('aria-invalid="true"');
    expect(recording).toContain('按下组合键');
  });

  it('keeps native region capture outside editable shortcuts and explains its reset exception', () => {
    const html = renderToStaticMarkup(<ShortcutPanel initialScope="web" onClose={() => {}}/>);
    expect(html).toContain('nc-shortcut-native');
    expect(html).toContain('划图翻译');
    expect(html).toContain('在浏览器中修改');
    expect(html).toContain('以取得截图授权');
    expect(html).toContain('不会随此面板恢复默认');
    expect(html).not.toContain('修改“划图翻译”的快捷键');
    expect(html).not.toContain('添加“划图翻译”的快捷键');
    expect(html).toContain('暂停或继续网页翻译');
  });

  it('does not show loading or saved success for a failed initial read', () => {
    preferences.ready = false;
    preferences.error = true;
    const html = renderToStaticMarkup(<ShortcutPanel initialScope="reader" onClose={() => {}}/>);
    expect(html).toContain('role="alert"');
    expect(html).toContain('快捷键读取失败，请重新打开面板。');
    expect(html).not.toContain('正在加载快捷键…');
    expect(html).not.toContain('快捷键已保存');
    const nextButtons = [...html.matchAll(/<button\b[^>]*>/g)].map(([tag]) => tag).filter(tag => tag.includes('aria-label="修改“下一页”的快捷键"'));
    expect(nextButtons.length).toBeGreaterThan(0);
    expect(nextButtons.every(tag => tag.includes('disabled=""'))).toBe(true);
  });
});
