from pathlib import Path
import cv2
import numpy as np
import pytest
from PIL import Image
from manhua_engine.quality import text_strip, conservative_mask, repair_region, repair_windows
from manhua_engine.layout import draw_region, FONT
from manhua_engine.vendor.ocr import ctc_decode


def test_ctc_keeps_same_char_separated_by_blank_and_normalizes_emitted_frames():
    logits=np.full((8,4),-3.,np.float32)
    indices=[0,1,1,0,1,2,2,0]
    logits[np.arange(8),indices]=3
    text,prob=ctc_decode(logits,['<blank>','哈','<SP>','好'])
    assert text=='哈哈 '
    assert prob==pytest.approx(1/(1+3*np.exp(-6)))
    text,prob,fg,bg=ctc_decode(logits*0,['<blank>','哈','<SP>','好'],np.zeros((8,6)))
    assert text=='' and prob==0 and fg==(0,0,0) and bg==(255,255,255)


def test_crop_keeps_vertical_reading_order_and_fractional_edges():
    rgb=np.full((120,100,3),255,np.uint8)
    rgb[10:40,20:40]=[255,0,0];rgb[70:100,20:40]=[0,0,255]
    q=np.array([[20.2,10.2],[39.8,10.2],[39.8,99.8],[20.2,99.8]],np.float32)
    strip=text_strip(rgb,q,pad=0)
    assert strip.shape[0]==48
    assert strip.shape[1]>200
    assert strip[24,20,0]>240 and strip[24,20,2]<10
    assert strip[24,-20,2]>240 and strip[24,-20,0]<10


def test_mask_does_not_remove_unrecognized_neighbour():
    seg=np.zeros((120,120),np.uint8);seg[25:35,25:35]=255;seg[80:90,80:90]=255
    quad=[[20,20],[40,20],[40,40],[20,40]]
    mask=conservative_mask([{'quads':[quad]}],seg)
    assert np.all(mask[25:35,25:35]==255)
    assert not mask[70:,70:].any()
    assert not conservative_mask([],seg).any()


def test_repair_is_local_and_preserves_aspect_ratio():
    rgb=np.full((100,300,3),127,np.uint8)
    mask=np.zeros((100,300),np.uint8);mask[40:60,140:160]=255
    class FakeNet:
        def predict(self,rgb,mask):
            ys,xs=np.where(mask>0)
            assert abs((xs.max()-xs.min())/(ys.max()-ys.min())-1)<.1
            assert rgb.shape[0]%8==rgb.shape[1]%8==0
            return np.full_like(rgb,255,dtype=np.float32)
    result=repair_region(FakeNet(),rgb,mask,768)
    assert np.array_equal(result[mask==0],rgb[mask==0])
    assert np.all(result[mask>0]==255)
    windows=repair_windows(mask)
    assert len(windows)==1 and windows[0][0]>0 and windows[0][2]<300


@pytest.mark.skipif(not Path(FONT).is_file(),reason='Install a CJK font for raster layout checks')
@pytest.mark.parametrize('direction,angle,text',[('v',0,'你好，世界！'),('h',15,'你好，世界！'),('v',0,'哈—…')])
def test_render_stays_inside_region(direction,angle,text):
    image=Image.new('RGB',(160,200),'white')
    region={'bbox':[40,30,90,150],'dir':direction,'angle':angle,'boxW':50,'boxH':120}
    result=draw_region(image,text,region,FONT,(0,0,0),(255,255,255))
    changed=np.any(np.array(image)!=255,axis=-1);ys,xs=np.where(changed)
    assert xs.size and xs.min()>=40 and xs.max()<90 and ys.min()>=30 and ys.max()<150
    assert result['rendered'] and result['font_px']>=4
    if text=='哈—…': assert result['font_px']>=10
