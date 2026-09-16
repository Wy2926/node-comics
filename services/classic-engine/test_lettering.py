import asyncio
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
import pytest
from lettering import LetteringError, changed_pixels, render_region


@pytest.mark.parametrize('point,protected,code', [((0,5),False,'BOUNDARY'), ((5,5),True,'OVERLAP')])
def test_specific_failure_reasons(point, protected, code):
    before=np.zeros((20,20,3),np.uint8)
    after=before.copy();after[point]=255
    guard=np.full((20,20),protected)
    with pytest.raises(LetteringError, match=code):
        changed_pixels(before,after,guard)


def test_unsafe_expansion_is_replaced_from_original_canvas():
    canvas=np.zeros((100,100,3),np.uint8)
    region=SimpleNamespace(min_rect=np.array([[[20,20],[80,20],[80,80],[20,80]]]),font_size=12)
    async def overflow(image,*args,**kwargs):
        image[0,0]=255
        return image
    def bounded(image,region,points,*args):
        assert not image.any()  # Failed layout must never leave glyphs behind.
        assert points.min() >= 2 and points.max() <= 98
        image[50,50]=255
        return image
    with patch('lettering.dispatch',overflow),patch('lettering.render',bounded):
        output,mask,fitted=asyncio.run(render_region(canvas,region,'font',10,np.zeros((100,100),bool)))
    assert fitted and mask.sum()==1 and not output[0,0].any() and not canvas.any()


def test_unavoidable_overlap_remains_failure():
    canvas=np.zeros((100,100,3),np.uint8)
    region=SimpleNamespace(min_rect=np.array([[[20,20],[80,20],[80,80],[20,80]]]),font_size=12)
    def draw(image,*args,**kwargs):
        image[50,50]=255
        return image
    async def natural(image,*args,**kwargs): return draw(image)
    with patch('lettering.dispatch',natural),patch('lettering.render',draw):
        with pytest.raises(LetteringError,match='OVERLAP'):
            asyncio.run(render_region(canvas,region,'font',10,np.ones((100,100),bool)))
