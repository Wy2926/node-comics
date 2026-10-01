import copy
import numpy as np
from PIL import Image, ImageDraw
from manhua_engine.bubbles import lettering_areas
from manhua_engine.layout import bubble_plan, draw_region, font_paths


def balloon():
    image = Image.new('RGB',(420,360),'#777777')
    ImageDraw.Draw(image).ellipse((65,35,355,325),fill='white',outline='black',width=4)
    return image


def test_english_uses_balloon_width_and_keeps_words_whole():
    image = balloon()
    region = {'bbox':[190,100,230,260],'dir':'v'}
    original = copy.deepcopy(region)
    area = lettering_areas(np.array(image),[region])[0]
    old = draw_region(image.copy(),'Tomorrow will surely be wonderful.',region,target='en')
    before = np.array(image)
    new = draw_region(image,'Tomorrow will surely be wonderful.',region,target='en',area=area)
    assert new['area_source']=='bubble' and new['font_px'] > old['font_px']*1.5
    assert ' '.join(new['lines'])=='Tomorrow will surely be wonderful.'
    assert region==original  # OCR/removal geometry is not modified.
    changed = np.any(np.array(image)!=before,axis=2)
    x0,y0,x1,y1 = area['bbox']
    allowed = np.zeros(changed.shape,bool)
    allowed[y0:y1,x0:x1] = area['mask']>0
    assert not np.any(changed & ~allowed)


def test_shared_balloon_assignments_and_fallback_boxes_do_not_overlap():
    image = balloon()
    regions = [{'bbox':[125,125,165,225],'dir':'v'}, {'bbox':[250,125,290,225],'dir':'v'}]
    areas = lettering_areas(np.array(image),regions)
    occupied = np.zeros((360,420),np.uint8)
    for area,other in zip(areas,reversed(regions)):
        assert area is not None
        x0,y0,x1,y1 = area['bbox']
        local = np.zeros_like(occupied)
        local[y0:y1,x0:x1] = area['mask']
        occupied += local
        a,b,c,d = other['bbox']
        assert not local[b:d,a:c].any()
    assert occupied.max()==1


def test_shared_horizontal_balloon_does_not_move_a_short_tail_into_a_side_wing():
    image = Image.new('RGB',(768,512),'#cedeea')
    ImageDraw.Draw(image).ellipse((86,51,684,259),fill='white',outline='black',width=3)
    regions = [{'bbox':[232,100,533,134],'dir':'h'}, {'bbox':[252,164,514,192],'dir':'h'}]
    areas = lettering_areas(np.array(image),regions)
    first = draw_region(image,'你好，朋友！',regions[0],target='zh-Hans',area=areas[0])
    assert first['area_source']=='bubble' and first['lines']==['你好，朋友！']
    plan = bubble_plan('你好，朋友！',font_paths((), 'zh'),round(first['font_px']*2),areas[0]['mask'])
    center = np.nonzero(areas[0]['mask'])[1].mean()
    assert all(x <= center < x+w for _,(x,y,w,h) in plan)
    second = draw_region(image,'我们来读书吧！',regions[1],target='zh-Hans',area=areas[1])
    assert second['area_source']=='bubble' and second['lines']==['我们来读书吧！']
    # Slot selection cannot enlarge a region's blank area into its neighbor.
    first_area = np.zeros((512,768),bool)
    x0,y0,x1,y1 = areas[0]['bbox']
    first_area[y0:y1,x0:x1] = areas[0]['mask']>0
    a,b,c,d = regions[1]['bbox']
    assert not first_area[b:d,a:c].any()


def test_rectangular_blank_area_keeps_wrapped_lines_on_the_same_center():
    image = Image.new('RGB',(420,300),'#777777')
    ImageDraw.Draw(image).rectangle((40,35,380,265),fill='white',outline='black',width=4)
    region = {'bbox':[185,75,235,225],'dir':'v'}
    area = lettering_areas(np.array(image),[region])[0]
    text = 'Tomorrow will surely be wonderful.'
    result = draw_region(image,text,region,target='en',area=area)
    assert result['area_source']=='bubble' and len(result['lines'])>1
    assert ' '.join(result['lines'])==text
    plan = bubble_plan(text,font_paths((), 'en'),round(result['font_px']*2),area['mask'])
    centers = [x+w/2 for _,(x,y,w,h) in plan]
    assert max(centers)==min(centers)


def test_blank_page_and_unbounded_artwork_do_not_become_a_balloon():
    image = Image.new('RGB',(420,360),'white')
    region = {'bbox':[190,100,230,260],'dir':'v'}
    assert lettering_areas(np.array(image),[region])==[None]
    ImageDraw.Draw(image).line((60,330,60,30,355,30,355,330),fill='black',width=4)
    assert lettering_areas(np.array(image),[region])==[None]


def test_dark_balloon_and_artwork_hole_are_protected():
    image = balloon()
    ImageDraw.Draw(image).rectangle((95,140,140,200),fill='black')
    region = {'bbox':[190,100,230,260],'dir':'v'}
    for rgb in (np.array(image),255-np.array(image)):
        area = lettering_areas(rgb,[region])[0]
        assert area is not None
        x0,y0,x1,y1 = area['bbox']
        allowed = np.zeros((360,420),np.uint8)
        allowed[y0:y1,x0:x1] = area['mask']
        assert not allowed[140:201,95:141].any()


def test_vertical_and_rotated_text_preserve_existing_orientation():
    image = balloon()
    region = {'bbox':[170,90,250,270],'dir':'v'}
    area = lettering_areas(np.array(image),[region])[0]
    layout = draw_region(image,'明日は晴れる。',region,target='ja',area=area)
    assert layout['direction']=='v' and layout['area_source']=='text'
    region['angle'] = 20
    assert lettering_areas(np.array(balloon()),[region])==[None]


def test_empty_regions_and_page_edge_boxes_are_valid():
    rgb = np.array(balloon())
    assert lettering_areas(rgb,[])==[]
    regions = [{'bbox':[-10,-10,30,50],'dir':'v'}, {'bbox':[500,500,510,550],'dir':'v'}]
    assert len(lettering_areas(rgb,regions))==2


def test_balloon_can_rescue_a_word_that_cannot_fit_the_ocr_box():
    image = balloon()
    region = {'bbox':[200,100,203,260],'dir':'v'}
    # Use a real detected balloon independently of this deliberately tiny box.
    area = lettering_areas(np.array(image),[{'bbox':[190,100,230,260],'dir':'v'}])[0]
    result = draw_region(image,'SUPERCALIFRAGILISTIC',region,target='en',area=area)
    assert result['area_source']=='bubble' and result['lines']==['SUPERCALIFRAGILISTIC']


def test_explicit_newlines_are_preserved_with_a_detected_balloon():
    image = balloon()
    region = {'bbox':[140,100,280,260],'dir':'v'}
    area = lettering_areas(np.array(image),[region])[0]
    result = draw_region(image,'Hello\nworld',region,target='en',area=area)
    assert result['lines']==['Hello','world']
