"""Offline synthetic acceptance for the pinned BallonsTranslator integration."""
import asyncio
import base64
from contextlib import redirect_stdout, redirect_stderr
import json
import logging
import os
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/'services/classic-engine'), str(ROOT/'engines/mit-native')]
os.environ.setdefault('MODEL_DIR', str(ROOT/'engines/mit-models'))
os.environ.setdefault('ENGINE_FONT', str(ROOT/'engines/mit-native/fonts/NotoSansMonoCJK-VF.ttf.ttc'))
logging.disable(logging.CRITICAL)
import cv2
import numpy as np
from PIL import Image, ImageDraw
import server
from hyphenation import configure_renderer
from manga_translator.utils import TextBlock
from speech_bubbles import find_bubble


async def main():
    destination = ROOT/'artifacts/bubble-lettering'
    destination.mkdir(parents=True, exist_ok=True)
    configure_renderer(server.text_render, languages=['en', 'ja'])
    server.text_render.FALLBACK_FONTS = [server.FONT]
    sheet = Image.new('RGB', (840, 1000), 'white')
    labels = ImageDraw.Draw(sheet)
    results = []
    samples = {'en': 'We can still find our way home. Stay together and follow the light beyond the mountains!',
               'ja': '大丈夫、みんなで力を合わせれば、きっと帰り道が見つかるよ。あの山の向こうに光が見える！'}
    with patch('urllib.request.urlopen', side_effect=AssertionError('Must render offline')):
        for index, (language, translation) in enumerate(samples.items()):
            image = np.full((480, 420, 3), 150, np.uint8)
            cv2.ellipse(image, (210,240), (145,180), 0,0,360, (255,255,255), -1)
            cv2.ellipse(image, (210,240), (145,180), 0,0,360, (0,0,0), 4)
            mask = np.zeros((480,420), np.uint8)
            mask[145:325,185:235] = 255
            row = {'lines': [[[185,145],[235,145],[235,325],[185,325]]], 'texts':['sample'],
                   'font_size':24,'fg_color':[0,0,0],'bg_color':[255,255,255]}
            analysis = {'segments':[{'id':'b001'}],'regions':[row],'mask':server.png(mask)}
            bubble = find_bubble(image,TextBlock(**row),[])
            assert bubble is not None
            with open(os.devnull,'w') as sink, redirect_stdout(sink), redirect_stderr(sink):
                result = await server.render_page(image,analysis,{'b001':translation},{'font_minimum':10},language,image.copy())
            glyphs = server.decode(result['glyph_mask'],'L') > 0
            output = server.decode(result['image'])
            assert result['bubble_regions'] == 1 and glyphs.any() and bubble.contains(glyphs)
            np.testing.assert_array_equal(output[~glyphs],image[~glyphs])
            (destination/f'{language}.png').write_bytes(base64.b64decode(result['image']))
            before = Image.fromarray(image)
            ImageDraw.Draw(before).rectangle((185,145,235,325),outline='red',width=2)
            sheet.paste(before,(0,index*500+20));sheet.paste(Image.fromarray(output),(420,index*500+20))
            labels.text((10,index*500+4), f'{language}: source text region',fill='black')
            labels.text((430,index*500+4),'BallonsTranslator bubble-constrained layout',fill='black')
            results.append({'language':language,'bubbles':result['bubble_regions'],
                            'fitted':result['layout_fitted_regions'],'glyph_pixels':int(glyphs.sum())})
    sheet.save(destination/'overview.png')
    report={'kind':'synthetic-lettering-only','network':False,'detector':'BallonsTranslator@84ba500', 'results':results}
    (destination/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    asyncio.run(main())
