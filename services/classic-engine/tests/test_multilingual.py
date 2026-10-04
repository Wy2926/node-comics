from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import socket
import unicodedata
import numpy as np
from PIL import Image
import pytest
from manhua_engine.languages import language_code, join_lines, text_language
from manhua_engine.layout import draw_region, horizontal_lines, font_paths, font_runs, break_units, measure


def test_explicit_release_fonts_do_not_depend_on_machine_fonts(tmp_path):
    custom = tmp_path / 'release-font.ttf'
    custom.touch()
    assert font_paths((str(custom),), 'ja') == (str(custom),)
    assert font_paths((str(custom), str(custom)), 'en') == (str(custom),)
from manhua_engine.ocr import Recognizer
from manhua_engine.quality import detection_windows, unique_quads
from manhua_engine.engine import group


@pytest.mark.parametrize('source,expected', [
    ('Test❤', 'Test♥'), ('Test❤️', 'Test♥'), ('♥\n❤', '♥\n♥'),
    ('A\U0010FFFFB', 'AB'), ('\U0010FFFF', ''), ('Cafe\u0301', 'Cafe\u0301'),
])
def test_missing_characters_are_replaced_then_removed(monkeypatch, source, expected):
    import manhua_engine.layout as layout
    cmap = frozenset(map(ord, 'TestABCafe♥\u0301'))
    monkeypatch.setattr(layout, 'coverage', lambda _: cmap)
    monkeypatch.setattr(layout, 'combined_coverage', lambda _: cmap)
    assert layout.supported_text(source, ('fixture',)) == expected


def test_supported_characters_are_never_replaced(monkeypatch):
    import manhua_engine.layout as layout
    text = 'Test❤️'
    monkeypatch.setattr(layout, 'coverage', lambda _: frozenset(map(ord, text)))
    assert layout.supported_text(text, ('fixture',)) is text


def test_missing_replacement_is_also_removed(monkeypatch):
    import manhua_engine.layout as layout
    monkeypatch.setattr(layout, 'coverage', lambda _: frozenset(map(ord, 'AB')))
    monkeypatch.setattr(layout, 'combined_coverage', lambda _: frozenset(map(ord, 'AB')))
    assert layout.supported_text('A❤B', ('fixture',)) == 'AB'


def test_mixed_font_text_does_not_repeat_grapheme_segmentation(monkeypatch):
    import manhua_engine.layout as layout
    maps = {'latin': frozenset(map(ord, 'abc')), 'cjk': frozenset(map(ord, '中文'))}
    monkeypatch.setattr(layout, 'coverage', maps.__getitem__)
    monkeypatch.setattr(layout, 'combined_coverage', lambda _: frozenset().union(*maps.values()))
    monkeypatch.setattr(layout, 'grapheme_clusters', lambda _: pytest.fail('cleanup repeated layout segmentation'))
    text = '中文abc' * 400
    assert layout.supported_text(text, tuple(maps)) is text


@pytest.mark.parametrize('name,expected',[('Japanese','ja'),('en-US','en'),('Korean','ko'),('中文','zh'),('Japanese and Chinese (mixed)','ja')])
def test_language_aliases(name,expected):
    assert language_code(name)==expected


def test_grouping_keeps_spaces_and_cjk_boundaries():
    assert join_lines(['Where are','you going?'],'en')=='Where are you going?'
    assert join_lines(['안녕하세요','세계'],'ko')=='안녕하세요 세계'
    assert join_lines(['明日は','晴れる。'],'ja')=='明日は晴れる。'
    assert join_lines(['Hello','world'],'ja')=='Hello world'


@pytest.mark.parametrize('language,expected',[('en','Where are you going?'),('ko','Where are you going?')])
def test_detected_horizontal_lines_form_readable_dialogue(language,expected):
    lines=[{'quad':[[20,y],[160,y],[160,y+20],[20,y+20]],'text':text,'prob':.99,'fg':[0,0,0],'bg':[255,255,255]}
           for y,text in [(20,'Where are'),(48,'you going?')]]
    regions=group(lines,400,200,language)
    assert len(regions)==1 and regions[0]['text']==expected


def test_panel_reading_order_follows_source_language():
    lines=[{'quad':[[x,20],[x+100,20],[x+100,40],[x,40]],'text':text,'prob':.99,'fg':[0,0,0],'bg':[255,255,255]}
           for x,text in [(20,'Left'),(400,'Right')]]
    assert [r['text'] for r in group(lines,600,200,'en')]==['Left','Right']
    assert [r['text'] for r in group(lines,600,200,'ja')]==['Right','Left']


@pytest.mark.parametrize('text,expected', [('Hello world','en'), ('안녕하세요 세계','ko'),
    ('明日は晴れる','ja'), ('今天晴天','zh'), ('Привет мир','en'), ('123!?','en')])
def test_automatic_joining_uses_script_not_a_required_source_language(text,expected):
    assert text_language(text)==expected


def test_auto_mixed_regions_keep_spaces_and_original_manga_panel_order():
    def region(x,texts):
        return [{'quad':[[x,y],[x+180,y],[x+180,y+20],[x,y+20]],
                 'text':text,'prob':.99,'fg':[0,0,0],'bg':[255,255,255]}
                for y,text in zip((20,48),texts)]
    lines=region(20,['Where are','you going?'])+region(500,['明日は','晴れる。'])
    def run(_):
        return [r['text'] for r in group(lines,800,200,'auto')]
    with ThreadPoolExecutor(4) as pool:
        results=list(pool.map(run,range(12)))
    assert results==[['明日は晴れる。','Where are you going?']]*12


def test_explicit_ja_ocr_keeps_the_multilingual_ctc_reference_path():
    model=Recognizer.__new__(Recognizer)
    model.language='ja'
    model.alphabet=['','A','<SP>','B']
    logits=np.array([[0,12,0,0],[12,0,0,0],[0,0,12,0],[0,0,0,12]],np.float32)
    model.infer=lambda crop:(logits,np.zeros((4,6),np.float32))
    assert model.forward(np.full((48,128,3),255,np.uint8))[0]=='A B'


def test_unicode_breaks_keep_punctuation_and_combining_sequences():
    assert break_units('Hello, world.')==('Hello, ','world.')
    assert all(not unit.startswith(('。','）','\u0301')) for unit in break_units('「日本語」。Cafe\u0301'))
    assert break_units('Hello\u00a0world')==('Hello\u00a0world',)


FONT_TESTS = pytest.mark.skipif(not Path('C:/Windows/Fonts/malgun.ttf').is_file(),reason='Windows multilingual font fixture')


@FONT_TESTS
def test_missing_glyph_cleanup_runs_once_before_font_size_probes(monkeypatch):
    import manhua_engine.layout as layout
    original = layout.supported_text
    calls = []
    def clean(text, paths):
        calls.append(text)
        return original(text, paths)
    monkeypatch.setattr(layout, 'supported_text', clean)
    region = {'bbox': [5, 5, 230, 155], 'dir': 'h'}
    expected = Image.new('RGB', (240, 160), 'white')
    actual = expected.copy()
    draw_region(expected, 'Hello world', region, target='en')
    result = draw_region(actual, 'Hello\U0010FFFF world', region, target='en')
    assert result['rendered'] and actual.tobytes() == expected.tobytes()
    assert len(calls) == 2


@FONT_TESTS
def test_layout_errors_distinguish_geometry_and_overflow():
    from manhua_engine.layout import LayoutError
    for bbox, code in [([1, 1, 1, 30], 'CLASSIC_REGION_INVALID'),
                       ([1, 1, 3, 3], 'CLASSIC_LAYOUT_OVERFLOW')]:
        with pytest.raises(LayoutError, match=code):
            draw_region(Image.new('RGB', (40, 40)), 'LongUnbreakable123456789',
                        {'bbox': bbox, 'dir': 'h'}, target='en')


@FONT_TESTS
def test_english_wraps_words_and_uses_local_hyphenation(monkeypatch):
    monkeypatch.setattr(socket,'create_connection',lambda *a,**k: pytest.fail('layout accessed network'))
    paths=font_paths((),'en')
    lines=horizontal_lines('Hello world again',paths,24,90,'en')
    assert lines==['Hello','world','again']
    lines=horizontal_lines('extraordinary',paths,24,95,'en')
    assert len(lines)>1 and all(line.endswith('-') for line in lines[:-1])
    assert ''.join(lines).replace('-','')=='extraordinary'
    assert all(measure(line,paths,24)[2]-measure(line,paths,24)[0]<=95 for line in lines)


@FONT_TESTS
@pytest.mark.parametrize('target,text,direction,expected',[
    ('English','Where are you going?','auto','h'),
    ('Korean','안녕하세요 세계','auto','h'),
    ('Japanese','「明日は晴れる。」','auto','v'),
    ('Chinese','你好，世界！','auto','v'),
    ('English','Cafe\u0301 déjà vu!','horizontal','h'),
    ('Japanese','HP 100回復！','vertical','v'),
    ('Japanese','ＬＩＮＥで連絡','vertical','v'),
])
def test_multilingual_render_bounds_and_orientation(target,text,direction,expected):
    image=Image.new('RGB',(300,260),'white')
    region={'bbox':[35,30,260,235],'dir':'v','angle':12,'boxW':180,'boxH':180}
    layout=draw_region(image,text,region,target=target,direction=direction)
    ys,xs=np.where(np.any(np.asarray(image)!=255,axis=-1))
    assert len(xs)>10 and xs.min()>=35 and xs.max()<260 and ys.min()>=30 and ys.max()<235
    assert layout['direction']==expected and layout['font_px']>=10
    assert layout['fonts']
    if expected=='h':
        assert ''.join(layout['lines']).replace(' ','')==unicodedata.normalize('NFC',text).replace(' ','')


@FONT_TESTS
def test_missing_font_fails_instead_of_tofu():
    with pytest.raises(ValueError,match='No font covers'):
        font_runs('\U0010FFFF',font_paths((),'en'))
    with pytest.raises(FileNotFoundError,match='Font not found'):
        font_paths(('missing-font.ttf',),'en')


@FONT_TESTS
def test_newlines_and_parallel_render_are_deterministic():
    def render(_):
        im=Image.new('RGB',(240,160),'white')
        layout=draw_region(im,'Hello\nworld',{'bbox':[5,5,230,155],'dir':'v'},target='en')
        assert layout['lines']==['Hello','world']
        return im.tobytes()
    with ThreadPoolExecutor(4) as pool:
        results=list(pool.map(render,range(12)))
    assert all(result==results[0] for result in results)


def test_parallel_render_uses_thread_local_font_faces():
    from threading import Barrier
    from manhua_engine.layout import font_at
    try:
        paths = font_paths((), 'zh')
    except FileNotFoundError:
        pytest.skip('Install a CJK font for concurrent raster checks')
    barrier = Barrier(4)
    texts = ['并行嵌字测试', '这是一段译文', '不同页面同时绘字', 'Hello world']
    def raster(index, parallel=False):
        face = font_at(paths[0], 24)
        if parallel:
            barrier.wait(timeout=5)
        canvas = Image.new('RGB', (240, 160), 'white')
        draw_region(canvas, texts[index], {'bbox': [5, 5, 230, 155], 'dir': 'h'},
                    font_path=paths, target='zh')
        return face, canvas.tobytes()
    expected = [raster(i)[1] for i in range(4)]
    with ThreadPoolExecutor(4) as pool:
        actual = list(pool.map(lambda i: raster(i, True), range(4)))
    assert len({id(face) for face, _ in actual}) == 4
    assert [pixels for _, pixels in actual] == expected


def test_webtoon_windows_cover_page_and_deduplicate_seams():
    for h,w in [(900,626),(4000,600),(600,4000)]:
        seen=np.zeros((h,w),np.uint8)
        for x0,y0,x1,y1 in detection_windows(h,w):
            assert 0<=x0<x1<=w and 0<=y0<y1<=h
            seen[y0:y1,x0:x1]+=1
        assert seen.min()>=1
        if max(h,w)/min(h,w)>2.5: assert seen.max()>1
    q=np.array([[10,10],[110,10],[110,50],[10,50]],np.float32)
    assert len(unique_quads([q,q+1,q+[0,100]]))==2


def test_missing_ocr_model_does_not_download(tmp_path,monkeypatch):
    monkeypatch.setattr(socket,'create_connection',lambda *a,**k: pytest.fail('OCR accessed network'))
    with pytest.raises(FileNotFoundError,match='download --ocr-language ko'):
        Recognizer(tmp_path,-1,1,'ko')
