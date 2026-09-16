"""Compare real original-model CPU/AMD checkpoints and render identical translations."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/'services/classic-engine'), str(ROOT/'engines/mit-native')]
os.environ['ENGINE_FONT'] = str(ROOT/'engines/mit-native/fonts/NotoSansMonoCJK-VF.ttf.ttc')
os.environ['ENGINE_PROFILE'] = 'mit'
os.environ['ENGINE_DEVICE'] = 'cpu'
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import server

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--parity', type=Path, default=ROOT/'private-test-data/amd-parity')
parser.add_argument('--live', type=Path, default=ROOT/'private-test-data/amd-original-models')
parser.add_argument('--image', type=Path, default=ROOT/'samples/starlight-bookshop.png')
parser.add_argument('--cpu-directory', default='cpu-docker', help='Original Docker baseline, or cpu for native PyTorch')
args = parser.parse_args()


async def main():
    source = np.array(Image.open(args.image).convert('RGB'))
    translations = json.loads((args.live/'stages.json').read_text(encoding='utf-8'))['translations']
    from hyphenation import DictionaryStore, default_directory
    from typesetter import initialize
    initialize(DictionaryStore(default_directory(), ['zh-Hans']))
    analyses, cleaned, masks, rendered, glyphs = {}, {}, {}, {}, {}
    config = {'font_minimum': 10}
    for device in ('cpu', 'directml-0'):
        folder = args.parity / (args.cpu_directory if device == 'cpu' else device)
        analyses[device] = json.loads((folder/'analysis.json').read_text(encoding='utf-8'))
        cleaned[device] = np.array(Image.open(folder/'cleaned.png').convert('RGB'))
        masks[device] = np.array(Image.open(folder/'mask.png').convert('L'))
        result = await server.render_page(source, analyses[device], translations, config, 'zh-Hans', cleaned[device])
        rendered[device] = server.decode(result['image'])
        glyphs[device] = server.decode(result['glyph_mask'], 'L')
        allowed = (masks[device] > 0) | (glyphs[device] > 0)
        np.testing.assert_array_equal(rendered[device][~allowed], source[~allowed])
        Image.fromarray(rendered[device]).save(args.live/(device+'-same-translation.png'))
    assert analyses['cpu']['segments'] == analyses['directml-0']['segments'], 'OCR text drift'
    np.testing.assert_array_equal(masks['cpu'], masks['directml-0'])
    difference = np.abs(cleaned['cpu'].astype(float) - cleaned['directml-0'].astype(float))
    rendered_difference = np.abs(rendered['cpu'].astype(float) - rendered['directml-0'].astype(float))
    report = {'segments':len(analyses['cpu']['segments']), 'ocr_identical':True, 'mask_identical':True,
              'cpu_unrecognized_regions':len(analyses['cpu'].get('unrecognized_regions',[])),
              'amd_unrecognized_regions':len(analyses['directml-0'].get('unrecognized_regions',[])),
              'cleaned_mean_absolute_error_255':float(difference.mean()),
              'cleaned_masked_mean_absolute_error_255':float(difference[masks['cpu']>0].mean()),
              'cleaned_max_pixel_difference_255':int(difference.max()),
              'render_mean_absolute_error_255':float(rendered_difference.mean()),
              'render_changed_pixel_fraction':float(np.any(rendered_difference>0,axis=2).mean()),
              'glyph_mask_identical':bool(np.array_equal(glyphs['cpu'],glyphs['directml-0'])),
              'outside_masks_unchanged':True}
    (args.live/'parity-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    width,height = source.shape[1],source.shape[0]
    comparison = Image.new('RGB',(width*2,height+60),'#edf0f5')
    draw = ImageDraw.Draw(comparison)
    font = ImageFont.truetype(server.FONT,28)
    for index,(label,device) in enumerate([('原方案 CPU · 相同译文','cpu'),('RX 6900 XT · 相同译文','directml-0')]):
        draw.text((index*width+24,12),label,font=font,fill='#182135')
        comparison.paste(Image.fromarray(rendered[device]),(index*width,60))
    comparison.save(args.live/'comparison.png')
    print(json.dumps(report),flush=True)


asyncio.run(main())
