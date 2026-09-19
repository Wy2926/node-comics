"""Real-model synthetic OCR and raster checks; no provider calls/private images."""
import argparse
import json
from pathlib import Path
from time import perf_counter
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont
from manhua_engine.engine import Engine
from manhua_engine.ocr import Recognizer
from manhua_engine.layout import draw_region
from manhua_engine.translation import atomic_json

CASES = [
    ('en','WHERE ARE YOU GOING?','arial.ttf','ko','어디에 가고 있어요?'),
    ('ko','안녕하세요 세계','malgun.ttf','en','Hello, world!'),
    ('zh','你好，世界！','msyh.ttc','ja','こんにちは、世界！'),
    ('latin','Café déjà vu!','arial.ttf','en','A familiar café!'),
    ('ja','明日はきっと晴れる。','YuGothR.ttc','en','Tomorrow will surely be sunny.'),
]


def fixture(text,font_name,size=36,vertical=False):
    font=ImageFont.truetype(f'C:/Windows/Fonts/{font_name}',size)
    image=Image.new('RGB',(720,600),'white');draw=ImageDraw.Draw(image)
    if vertical:
        for i,char in enumerate(text): draw.text((340,45+i*size),char,font=font,fill='black',anchor='lt')
        box=(340,45,340+size,45+len(text)*size)
    else:
        box=draw.textbbox((0,0),text,font=font)
        w,h=box[2]-box[0],box[3]-box[1]
        draw.text(((720-w)//2-box[0],280-box[1]),text,font=font,fill='black')
        box=((720-w)//2,280,(720+w)//2,280+h)
    x0,y0,x1,y1=box
    quad=np.array([[x0-5,y0-5],[x1+5,y0-5],[x1+5,y1+5],[x0-5,y1+5]],np.float32)
    return image,quad


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path,default=Path('artifacts/multilingual'))
    a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
    engine=Engine();rows=[];preview=Image.new('RGB',(1200,1000),'#edf0f4')
    try:
        for index,(lang,text,font_name,target,translation) in enumerate(CASES):
            engine.ocr=Recognizer('models',0,2,lang)
            image,quad=fixture(text,font_name);rgb=np.array(image)
            engine.ocr.read(rgb,quad)  # exclude lazy ORT kernel initialization
            start=perf_counter()
            results=[engine.ocr.read(rgb,quad) for _ in range(3)]
            read_ms=(perf_counter()-start)*1000/3
            source=a.output/f'{lang}-source.png';image.save(source)
            class FixtureTranslator:
                def translate(self,texts):
                    return [translation for _ in texts]
            translator=FixtureTranslator();translator.target=target
            engine.page(source,translator,a.output/'pipeline')
            page=json.loads((a.output/'pipeline'/f'{lang}-source.json').read_text(encoding='utf-8'))
            row={'language':lang,'expected':text,'recognized':results[0]['text'] if results[0] else None,
                 'exact_repeats':sum(r is not None and r['text']==text for r in results),
                 'pipeline_exact':len(page['regions'])==1 and page['regions'][0]['text']==text,
                 'pipeline_regions':len(page['regions']),
                 'read_ms':read_ms}
            # A separate visible bubble provides room to inspect target-language typography.
            tile=Image.new('RGB',(560,160),'white');d=ImageDraw.Draw(tile)
            d.rounded_rectangle((2,2,558,158),radius=45,outline='#44546a',width=2)
            row['layout']=draw_region(tile,translation,{'bbox':[25,18,535,143],'dir':'h' if target=='ja' else 'v'},target=target)
            preview.paste(tile,(620,index*195+28))
            crop=image.crop((int(quad[:,0].min())-8,int(quad[:,1].min())-8,int(quad[:,0].max())+8,int(quad[:,1].max())+8))
            crop.thumbnail((550,150));preview.paste(crop,(20+(560-crop.width)//2,index*195+55))
            ImageDraw.Draw(preview).text((24,index*195+10),f'{lang} OCR -> {target} layout',fill='black')
            rows.append(row)
        # Vertical Japanese exercises MIT's clockwise/anticlockwise crop contract.
        engine.ocr=Recognizer('models',0,2,'ja')
        image,quad=fixture('こんにちは世界','YuGothR.ttc',vertical=True)
        result=engine.ocr.read(np.array(image),quad)
        rows.append({'language':'ja-vertical','expected':'こんにちは世界','recognized':result['text'] if result else None})
        for lang,text,font_name,_,_ in CASES[:2]:
            engine.ocr=Recognizer('models',0,2,lang)
            for style in ('small','inverted','rotated'):
                image,quad=fixture(text,font_name,size=18 if style=='small' else 36)
                rgb=np.array(image)
                if style=='inverted': rgb=255-rgb
                if style=='rotated':
                    matrix=cv2.getRotationMatrix2D((360,300),15,1)
                    rgb=cv2.warpAffine(rgb,matrix,(720,600),borderValue=(255,255,255))
                    quad=cv2.transform(quad[None],matrix)[0]
                result=engine.ocr.read(rgb,quad)
                rows.append({'language':lang+'-'+style,'expected':text,'recognized':result['text'] if result else None})
        # Long strips must retain text at every seam rather than reducing a chapter to 1280 px.
        image,quad=fixture(CASES[0][1],CASES[0][2])
        webtoon=Image.new('RGB',(720,3600),'white')
        for i in range(6): webtoon.paste(image,(0,i*600))
        engine.ocr=Recognizer('models',0,2,'en')
        rgb=np.array(webtoon);quads,_=engine.detect(rgb)
        results=list(engine.ocr_pool.map(lambda q: engine.read_line(rgb,q),quads))
        webtoon_ok=len(results)==6 and all(r and r['text']==CASES[0][1] for r in results)
        preview.save(a.output/'preview.png')
        report={'kind':'synthetic standard-font smoke; fixed fixture translations, no online translation evaluation',
                'ocr_exact':sum(r['recognized']==r['expected'] for r in rows),'ocr_cases':len(rows),
                'pipeline_exact':sum(r.get('pipeline_exact',False) for r in rows),'pipeline_cases':len(CASES),
                'webtoon_lines':len(results),'webtoon_passed':webtoon_ok,'rows':rows}
        atomic_json(a.output/'validation.json',report)
        print(json.dumps({k:v for k,v in report.items() if k!='rows'},indent=2))
        if report['ocr_exact']!=len(rows) or report['pipeline_exact']!=len(CASES) or not webtoon_ok:
            raise SystemExit(1)
    finally: engine.close()


if __name__=='__main__': main()
