from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import socket
import unicodedata
import numpy as np
from PIL import Image
import pytest
from manhua_engine.languages import language_code, join_lines
from manhua_engine.layout import draw_region, horizontal_lines, font_paths, font_runs, break_units, measure
from manhua_engine.ocr import Recognizer
from manhua_engine.quality import detection_windows, unique_quads
from manhua_engine.engine import group


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


def test_unicode_breaks_keep_punctuation_and_combining_sequences():
    assert break_units('Hello, world.')==('Hello, ','world.')
    assert all(not unit.startswith(('。','）','\u0301')) for unit in break_units('「日本語」。Cafe\u0301'))
    assert break_units('Hello\u00a0world')==('Hello\u00a0world',)


FONT_TESTS = pytest.mark.skipif(not Path('C:/Windows/Fonts/malgun.ttf').is_file(),reason='Windows multilingual font fixture')


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
