import {beforeEach, describe, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {AnalyticsPrompt} from '../src/analytics/AnalyticsPrompt';
import {AnalyticsConsent} from '../src/analytics/AnalyticsConsent';

const preferences = vi.hoisted(() => ({
  ready: true, enabled: false, promptHandled: false, available: true,
  pending: false, error: '', choose: vi.fn(),
}));
vi.mock('../src/analytics/useAnalyticsConsentActions', () => ({useAnalyticsConsentActions: () => preferences}));

beforeEach(() => {
  Object.assign(preferences, {ready: true, enabled: false, promptHandled: false, available: true, pending: false, error: ''});
  preferences.choose.mockClear();
});

describe('bookshelf analytics consent presentation', () => {
  it('waits for persisted preferences and only appears on the active bookshelf', () => {
    expect(renderToStaticMarkup(<AnalyticsPrompt active={false}/>)).toBe('');
    for (const hidden of [{ready: false}, {enabled: true}, {promptHandled: true}, {available: false}]) {
      Object.assign(preferences, {ready: true, enabled: false, promptHandled: false, available: true}, hidden);
      expect(renderToStaticMarkup(<AnalyticsPrompt active/>)).toBe('');
    }
    expect(preferences.choose).not.toHaveBeenCalled();
  });

  it('offers equal buttons and an explicit close action without a modal or automatic focus', () => {
    const html = renderToStaticMarkup(<AnalyticsPrompt active/>);
    expect(html).toContain('帮助改进 NodeLane（可选）');
    expect(html).toContain('NodeLane 与 Google Analytics 4');
    expect(html).toContain('随机标识');
    expect(html).toContain('漫画内容、标题、搜索词、文件名或网页地址');
    expect(html).toContain('允许使用分析');
    expect(html).toContain('不发送并关闭提示');
    expect(html.match(/class="button secondary small"/g)).toHaveLength(2);
    expect(html).not.toMatch(/<dialog|aria-modal|autofocus/i);
    expect(preferences.choose).not.toHaveBeenCalled();
  });

  it('shares disclosure with settings and prevents changes until the saved choice is loaded', () => {
    preferences.ready = false;
    const html = renderToStaticMarkup(<AnalyticsConsent/>);
    expect(html).toContain('aria-label="帮助改进 NodeLane"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('NodeLane 与 Google Analytics 4');
    expect(html).toContain('隐私政策');
  });

  it('keeps consent failures visible and leaves both choices available for retry', () => {
    preferences.error = '浏览器未允许使用情况分析，设置保持关闭。';
    const html = renderToStaticMarkup(<AnalyticsPrompt active/>);
    expect(html).toContain('role="alert"');
    expect(html).toContain(preferences.error);
    expect(html).not.toContain('disabled=""');
  });
});
