"""Own the existing script routing, probe reuse and language experts."""
import numpy as np

from classic_node.timing import stage
from . import Reading


class ClassicOCR:
    identity = {'backend': 'classic'}

    def __init__(self, models, gpu, threads, *, backend='cuda', **options):
        from .paddle import Paddle
        from .japanese import Japanese
        from .routing import ScriptRouter
        self.recognizers = {language: Paddle(models, language, gpu, threads, backend=backend, **options)
                            for language in ('en', 'ch', 'korean')}
        self.japanese = Japanese(models, gpu, backend=backend)
        self.router = ScriptRouter(models, self.recognizers)

    async def recognize(self, image, blocks, config):
        from manga_translator.utils import Quadrilateral
        groups = [[Quadrilateral(np.asarray(line), '', 1) for line in block.lines] for block in blocks]
        with stage('analyze_route'):
            routes, readings = self.router.classify(image, blocks, groups)
        for group, reading in zip(groups, readings, strict=True):
            if reading is not None:
                index, row = reading
                group[index].text = row['text'] if row['conf'] >= config.prob else ''
                group[index].prob = row['conf']
        with stage('analyze_ocr'):
            for language, model in self.recognizers.items():
                selected = [line for route, group, reading in zip(routes, groups, readings, strict=True)
                            if route == language for index, line in enumerate(group)
                            if reading is None or index != reading[0]]
                if selected:
                    await model.recognize(image, selected, config)
            japanese = [i for i, route in enumerate(routes) if route == 'japan']
            if japanese:
                self.japanese.recognize(image, [blocks[i] for i in japanese], [groups[i] for i in japanese])
        return [Reading([line.text for line in group], route, route != 'japan' or len(group) == 1)
                for group, route in zip(groups, routes, strict=True)]

    async def warmup(self, image, config):
        from manga_translator.utils import Quadrilateral
        for model in self.recognizers.values():
            await model.recognize(image, [Quadrilateral(
                np.array([[20, 20], [240, 20], [240, 68], [20, 68]]), '', 1)], config)
        # Manga OCR warms its model during construction.
        self.router.choose({lang: {'text': 'test', 'conf': .9}
                            for lang in ('en', 'ch', 'japan', 'korean')})

    def close(self):
        for model in (*self.recognizers.values(), self.japanese):
            model.close()
