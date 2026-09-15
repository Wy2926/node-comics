"""Exercise private stage routing without loading models or a text provider."""
import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

import numpy as np
from fastapi import HTTPException

import server


class Request:
    def __init__(self, body):
        self.body = json.dumps(body).encode()

    async def stream(self):
        yield self.body


class StageTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.image = np.full((64, 80, 3), 200, np.uint8)
        self.body = {'image': server.png(self.image), 'config': {'version': server.VERSION},
                     'analysis': {'mask': 'stage-only-test'}}

    async def test_inpaint_needs_no_translation_or_language(self):
        with patch.object(server, 'erase_page', new=AsyncMock(return_value={'cleaned': self.body['image']})) as erase:
            result = await server.process('inpaint', Request(self.body))
        erase.assert_awaited_once()
        self.assertEqual((result['width'], result['height'], result['version']), (80, 64, server.VERSION))
        self.assertEqual(result['cleaned'], self.body['image'])

    async def test_render_receives_cleaned_image_without_calling_inpaint(self):
        self.body.update(cleaned=self.body['image'], translations={'b001': 'translated'}, language='en')
        with patch.object(server, 'render_page', new=AsyncMock(return_value={'image': self.body['image']})) as render, \
             patch.object(server, 'erase_page', new=AsyncMock()) as erase:
            await server.process('render', Request(self.body))
        erase.assert_not_awaited()
        render.assert_awaited_once()
        np.testing.assert_array_equal(render.call_args.args[-1], self.image)

    async def test_missing_cleaned_image_fails_without_falling_back_to_inpaint(self):
        self.body.update(translations={}, language='en')
        with patch.object(server, 'erase_page', new=AsyncMock()) as erase:
            result = await server.process('render', Request(self.body))
        self.assertEqual(result.status_code, 422)
        erase.assert_not_awaited()

    async def test_old_version_rejected_before_running_a_stage(self):
        self.body['config']['version'] = 'mit-95227a2-classic-v2-crops'
        with patch.object(server, 'erase_page', new=AsyncMock()) as erase:
            with self.assertRaises(HTTPException) as error:
                await server.process('inpaint', Request(self.body))
        self.assertEqual(error.exception.status_code, 409)
        erase.assert_not_awaited()

    async def test_parallel_transport_cannot_overlap_two_image_stages(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def erase(*args):
            entered.set()
            await release.wait()
            return {'cleaned': self.body['image']}

        with patch.object(server, 'erase_page', new=erase), \
             patch.object(server, 'analyze', new=AsyncMock(return_value={})) as analyze:
            erasing = asyncio.create_task(server.process('inpaint', Request(self.body)))
            try:
                await asyncio.wait_for(entered.wait(), 2)
                analyzing = asyncio.create_task(server.process('analyze', Request(self.body)))
                await asyncio.sleep(0)
                analyze.assert_not_awaited()
            finally:
                release.set()
                await erasing
            await analyzing
        analyze.assert_awaited_once()


if __name__ == '__main__':
    unittest.main()
