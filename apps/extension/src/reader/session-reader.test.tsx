import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {defaults} from '../types';
import {SessionReader, type SessionReaderPage} from './SessionReader';
import * as Status from './ImageTranslationStatus';

const pages: SessionReaderPage[] = Array.from({length: 1500}, (_, index) => ({id: `page-${index}`, name: `Page ${index + 1}`, width: 800, height: 1200}));
beforeEach(() => {
  vi.stubGlobal('document', {hidden: false});
  vi.stubGlobal('window', {matchMedia: () => ({matches: false})});
  vi.stubGlobal('localStorage', {getItem: () => {throw Error('Source-page storage is forbidden');}, setItem: () => {throw Error('Source-page storage is forbidden');}});
});
afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks();});
const render = (options: Partial<Parameters<typeof SessionReader>[0]> = {}) => renderToStaticMarkup(<SessionReader
  title="Source chapter" pages={pages} settings={defaults} setSettings={vi.fn()} onExit={vi.fn()}
  loadImage={vi.fn(async () => ({blob: new Blob(), release: vi.fn()}))} {...options}/>);

describe('temporary reader presentation', () => {
  it('projects at most eleven page elements from a long chapter without fetching or local storage', () => {
    const loadImage = vi.fn(async () => ({blob: new Blob(), release: vi.fn()}));
    const html = render({loadImage, initialAnchor: {pageId: 'page-749', relativeOffset: .42}});
    expect((html.match(/data-page-id=/g) ?? []).length).toBe(11);
    expect(html).toContain('data-page-id="page-749"');
    expect(html).not.toContain('data-page-id="page-0"');
    expect(html).toContain('data-decoded-pages="11"');
    expect(html).toContain('data-reader-viewport="true"');
    expect(html).not.toContain('data-sync=');
    expect(loadImage).not.toHaveBeenCalled();
  });
  it('renders only the selected single page', () => {
    const html = render({settings: {...defaults, layout: 'single'}, initialAnchor: {pageId: 'page-99', relativeOffset: 0}});
    expect((html.match(/data-page-id=/g) ?? []).length).toBe(1);
    expect(html).toContain('data-page-id="page-99"');
    expect(html).toContain('data-decoded-pages="1"');
  });
  it('unmounts hidden pixel presentations while retaining the bounded page frames and anchor', () => {
    const options={initialAnchor:{pageId:'page-749',relativeOffset:.42}};
    vi.stubGlobal('document',{hidden:true});
    const hidden=render(options);
    expect((hidden.match(/data-page-id=/g) ?? []).length).toBe(11);
    expect(hidden).toContain('data-page-id="page-749"');
    expect(hidden).toContain('data-decoded-pages="0"');
    expect(hidden).not.toContain('nc-image-placeholder');
    vi.stubGlobal('document',{hidden:false});
    const visible=render(options);
    expect((visible.match(/nc-image-placeholder/g) ?? []).length).toBe(11);
    expect(visible).toContain('data-current-page="750"');
  });
  it('retains an explicitly active translation view but does not enable it by default', () => {
    expect(render()).toMatch(/aria-label="原图" aria-pressed="true"/);
    expect(render({initialView: 'translation'})).toMatch(/aria-label="译图" aria-pressed="true"/);
    expect(render()).toContain('aria-label="返回网页"');
  });
  it('distinguishes incomplete discovery and a verified chapter end', () => {
    expect(render({complete: false})).toContain('当前已发现 1500 页');
    expect(render({complete: true})).toContain('已到当前内容末尾');
  });
  it('reuses the dismissible shared error status only in translation view and preserves error details', () => {
    const failed:SessionReaderPage[] = [{...pages[0], status: {kind:'error',message: 'Provider unavailable', retryable: true}}];
    expect(render({pages: failed})).not.toContain('Provider unavailable');
    const html = render({pages: failed, initialView: 'translation', onRetry: vi.fn()});
    expect(html).toContain('title="Provider unavailable"');
    expect(html).toContain('nc-image-status-layer');expect(html).toContain('nc-image-translation error is-dismissible');
    expect(html).toContain('aria-label="翻译失败 · 重试"');expect(html).toContain('aria-label="关闭错误提示"');
    expect(html).not.toContain('nc-session-page-status');
  });
  it('keeps non-retryable errors dismissible without inventing a retry action',()=>{
    const html=render({pages:[{...pages[0],status:{kind:'error',message:'结果待核实',retryable:false}}],initialView:'translation',onRetry:vi.fn()});
    expect(html).toContain('结果待核实');expect(html).toContain('nc-image-translation-body');
    expect(html).toContain('aria-label="关闭错误提示"');expect(html).not.toContain('nc-image-translation-action');
  });
  it.each(['waiting','translating'] as const)('retains the shared %s activity indicator and original stage message',kind=>{
    const html=render({pages:[{...pages[0],status:{kind,message:'真实处理阶段'}}],initialView:'translation'});
    expect(html).toContain(`nc-image-translation ${kind}`);expect(html).toContain(`nc-task-animation ${kind}`);
    expect(html).toContain('真实处理阶段');expect(html).not.toContain('关闭错误提示');
  });
  it.each(['error','login','upgrade'] as const)('routes shared %s recovery through the owning page retry callback',kind=>{
    const component=vi.spyOn(Status,'ImageTranslationStatus').mockImplementation(()=>null),retry=vi.fn();
    const state={kind,message:'Recovery required'};
    render({pages:[{...pages[0],status:state}],initialView:'translation',onRetry:retry});
    expect(component).toHaveBeenCalledOnce();
    const props=component.mock.calls[0][0];expect(props.state).toBe(state);
    if(kind==='login')props.onLogin();else if(kind==='upgrade')props.onUpgrade();else void props.onRetry();
    expect(retry).toHaveBeenCalledExactlyOnceWith(pages[0].id);
  });
  it('handles an empty or replaced page list without fabricating a page', () => {
    const html = render({pages: [], initialAnchor: {pageId: 'removed', relativeOffset: .5}});
    expect(html).toContain('data-page-count="0"');
    expect(html).not.toContain('data-page-id=');
  });
});
