import asyncio,json,logging,time
from pathlib import Path
import numpy as np
from PIL import Image
import server

async def main():
    output=Path('/output')
    output.mkdir(parents=True,exist_ok=True)
    source=np.array(Image.open('/source.png').convert('RGB'))
    config={'version':server.VERSION,'detection_size':1536,'reading_order':'rtl','mask_dilation':3,
            'inpainting_strategy':'masked-crops-v1','inpainting_size':512,'inpainting_padding':48,
            'inpainting_merge_gap':24,'font_minimum':10}
    async with server.lifespan(server.app):
        analysis=await server.analyze(source,config)
        painted=await server.erase_page(source,analysis,config)
        (output/'analysis.json').write_text(json.dumps(analysis,ensure_ascii=False),encoding='utf-8')
        Image.fromarray(server.decode(analysis['mask'],'L')).save(output/'mask.png')
        Image.fromarray(server.decode(painted['cleaned'])).save(output/'cleaned.png')
        report={'torch':server.torch.__version__,'segments':len(analysis['segments']),
                'timings':{**analysis['timings'],**painted['timings']}}
        (output/'report.json').write_text(json.dumps(report,indent=2))
        print(json.dumps(report),flush=True)
asyncio.run(main())
