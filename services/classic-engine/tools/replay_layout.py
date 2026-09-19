"""Replay saved OCR/translation records without OCR or translation requests.

Reconstruct removal with the local detector/inpainter, verify the old raster,
then compare lettering on exactly the same cleaned pixels.
"""
import argparse
import html
import json
import statistics
from pathlib import Path
from time import perf_counter
import numpy as np
from PIL import Image
from manhua_engine.engine import Engine
from manhua_engine.bubbles import lettering_areas
from manhua_engine.layout import draw_region, resolve_colors
from manhua_engine.quality import conservative_mask
from manhua_engine.translation import atomic_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--baseline',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--target',required=True)
    parser.add_argument('--limit',type=int)
    args = parser.parse_args()
    if args.output.resolve() in (args.source.resolve(),args.baseline.resolve()):
        parser.error('--output must differ from the source and baseline directories')
    args.output.mkdir(parents=True,exist_ok=True)
    engine = Engine()
    rows = []
    started = perf_counter()
    try:
        records = sorted(args.baseline.glob('*.json'))
        records = [p for p in records if p.stem not in ('report','summary')]
        if args.limit:
            records = records[:args.limit]
        for path in records:
            record = json.loads(path.read_text(encoding='utf-8'))
            source = args.source/record['page']
            rgb = np.array(Image.open(source).convert('RGB'))
            regions = record['regions']
            _,seg = engine.detect(rgb)
            cleaned,_ = engine.remove(rgb,conservative_mask(regions,seg))
            old = Image.fromarray(cleaned)
            image = old.copy()
            start = perf_counter()
            areas = lettering_areas(cleaned,regions)
            geometry_ms = (perf_counter()-start)*1000
            render_s = 0.
            changes = []
            for region,area in zip(regions,areas):
                fg,bg = resolve_colors(cleaned,region['bbox'])
                before = draw_region(old,region['translation'],region,fill=fg,stroke=bg,target=args.target)
                start = perf_counter()
                after = draw_region(image,region['translation'],region,fill=fg,stroke=bg,target=args.target,area=area)
                render_s += perf_counter()-start
                region['layout'] = after
                changes.append({'before':before,'after':after})
            with Image.open(args.baseline/path.with_suffix('.png').name) as saved:
                identical = saved.convert('RGB').tobytes()==old.tobytes()
            image.save(args.output/path.with_suffix('.png').name,compress_level=1)
            record['layout_replay'] = {'baseline_pixel_identical':identical,'geometry_ms':geometry_ms,'render_s':render_s}
            atomic_json(args.output/path.name,record)
            rows.append({'page':source.name,'baseline_pixel_identical':identical,'geometry_ms':geometry_ms,
                         'render_s':render_s,'regions':changes})
            if len(rows)%10==0:
                print(f'{len(rows)}/{len(records)} pages',flush=True)
    finally:
        engine.close()
    changed = [r for p in rows for r in p['regions'] if r['after'].get('area_source')=='bubble']
    all_regions = [r for p in rows for r in p['regions'] if r['before'].get('rendered')]
    report = {'pages':len(rows),'regions':len(all_regions),'bubble_regions':len(changed),
              'baseline_pixel_identical':sum(p['baseline_pixel_identical'] for p in rows),
              'median_font_before':statistics.median(r['before']['font_px'] for r in changed) if changed else None,
              'median_font_after':statistics.median(r['after']['font_px'] for r in changed) if changed else None,
              'hyphenated_lines_before':sum(l.endswith('-') for r in all_regions for l in r['before']['lines']),
              'hyphenated_lines_after':sum(l.endswith('-') for r in all_regions for l in r['after']['lines']),
              'mean_geometry_ms':statistics.mean(p['geometry_ms'] for p in rows),
              'mean_render_s':statistics.mean(p['render_s'] for p in rows),
              'wall_s':perf_counter()-started,'translation_requests':0,'ocr_requests':0}
    atomic_json(args.output/'report.json',report|{'pages_detail':rows})
    content = ['<!doctype html><meta charset="utf-8"><title>Lettering comparison</title>',
               '<style>body{background:#17191e;color:#eee;font:16px system-ui;margin:24px}a{color:#9cf}',
               '.pages{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}img{width:100%}</style>',
               '<h1>原图 / 优化前 / 气泡区域排版</h1>',
               '<p>相同 OCR、译文和擦字背景；完整单词换行，气泡内留边距。点击图片查看原尺寸。</p>',
               '<pre>'+html.escape(json.dumps(report,ensure_ascii=False,indent=2))+'</pre>']
    for page in rows:
        name = Path(page['page']).with_suffix('.png').name
        content.append('<h2>'+html.escape(page['page'])+'</h2><div class="pages">')
        for label,path in [('原图',args.source/page['page']),('之前',args.baseline/name),('优化后',args.output/name)]:
            url = path.resolve().as_uri()
            content.append(f'<div><p>{label}</p><a href="{url}"><img loading="lazy" src="{url}"></a></div>')
        content.append('</div>')
    (args.output/'index.html').write_text(''.join(content),encoding='utf-8')
    print(json.dumps(report,indent=2))
    if report['baseline_pixel_identical'] != len(rows):
        raise SystemExit('Some baseline pixels differed; inspect before comparing.')


if __name__=='__main__':
    main()
