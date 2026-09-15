"""Compare original CPU and AMD model outputs; no text provider is called.

Run with the engine virtual environment. All page evidence stays in the ignored
directory; the console prints counts, timing and device names only.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--device', choices=['cpu', 'directml:0'], required=True)
parser.add_argument('--image', type=Path, default=ROOT/'samples/starlight-bookshop.png')
parser.add_argument('--directory', type=Path, default=ROOT/'private-test-data/amd-parity')
args = parser.parse_args()
folder = args.directory.resolve() / args.device.replace(':', '-')
folder.mkdir(parents=True, exist_ok=True)
sys.path[:0] = [str(ROOT/'services/classic-engine'), str(ROOT/'engines/mit-native')]
os.environ.update(ENGINE_PROFILE='mit-directml' if args.device.startswith('directml') else 'mit',
                  ENGINE_DEVICE=args.device, MODEL_DIR=str(ROOT/'engines/mit-models'),
                  ENGINE_FONT=str(ROOT/'engines/mit-native/fonts/NotoSansMonoCJK-VF.ttf.ttc'),
                  ENGINE_LOCK_DIR=str(ROOT/'engines/device-locks'), ENGINE_PROFILE_DIR=str(folder))
import numpy as np
from PIL import Image
import server


async def main():
    config = {'version': server.VERSION, 'detection_size': 1536, 'reading_order': 'rtl', 'mask_dilation': 3,
              'inpainting_strategy': 'masked-crops-v1', 'inpainting_size': 512, 'inpainting_padding': 48,
              'inpainting_merge_gap': 24, 'font_minimum': 10}
    image = np.array(Image.open(args.image).convert('RGB'))
    started = time.monotonic()
    async with server.lifespan(server.app):
        print(json.dumps({'event':'MODELS_READY','device':args.device,'seconds':time.monotonic()-started}),flush=True)
        analysis = await server.analyze(image, config)
        (folder/'analysis.json').write_text(json.dumps(analysis,ensure_ascii=False),encoding='utf-8')
        Image.fromarray(server.decode(analysis['mask'],'L')).save(folder/'mask.png')
        print(json.dumps({'event':'OCR_DONE','segments':len(analysis['segments']),'timings':analysis['timings']}),flush=True)
        erased = await server.erase_page(image, analysis, config)
        cleaned = server.decode(erased['cleaned'])
        Image.fromarray(cleaned).save(folder/'cleaned.png')
        mask = server.decode(analysis['mask'],'L')
        np.testing.assert_array_equal(cleaned[mask==0], image[mask==0])
        report={'device':args.device,'segments':len(analysis['segments']), 'quality_flags':analysis.get('quality_flags',[]),
                'timings':{**analysis['timings'],**erased['timings']},'health':server.health(),
                'outside_mask_unchanged':True}
        (folder/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps({'event':'IMAGE_STAGES_DONE','timings':report['timings']}),flush=True)


if __name__ == '__main__':
    asyncio.run(main())
