"""Exercise private stage routing without loading models or a text provider."""
import asyncio
import json
import unittest
import tempfile
from threading import Event
from unittest.mock import AsyncMock, patch

import numpy as np
from fastapi import HTTPException

import server
from runtime import DeviceLock, ImageCache


class Request:
    def __init__(self, body):
        self.body = json.dumps(body).encode()

    async def stream(self):
        yield self.body


class StageTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        server.lock = DeviceLock('isolated-test-device', self.temp.name)
        server.cache = ImageCache(1024 * 1024, 60)
        self.image = np.full((64, 80, 3), 200, np.uint8)
        self.body = {'image': server.png(self.image), 'config': {'version': server.VERSION},
                     'scope': 'task-1', 'analysis': {'mask': 'stage-only-test'}}
        self.rendered = {'image': self.image, 'glyph_mask': np.zeros(self.image.shape[:2], np.uint8),
                         'mask': 'checked-erase-mask', 'timings': {'render': 0.01}}

    async def test_inpaint_needs_no_translation_or_language(self):
        with patch.object(server, 'erase_page', new=AsyncMock(return_value={'cleaned': self.image.copy()})) as erase:
            result = await server.process('inpaint', Request(self.body))
        erase.assert_awaited_once()
        self.assertEqual((result['width'], result['height'], result['version']), (80, 64, server.VERSION))
        self.assertTrue(result['cached'])
        self.assertEqual(len(result['cache_key']), 64)
        self.assertNotIn('cleaned', result)

    async def test_render_receives_cleaned_image_without_calling_inpaint(self):
        with patch.object(server, 'erase_page', new=AsyncMock(return_value={'cleaned': self.image.copy()})):
            painted = await server.process('inpaint', Request(self.body))
        self.body.update(cache_key=painted['cache_key'], translations={'b001': 'translated'}, language='en')
        with patch.object(server, 'render_page', new=AsyncMock(return_value=self.rendered)) as render, \
             patch.object(server, 'erase_page', new=AsyncMock()) as erase:
            await server.process('render', Request(self.body))
        erase.assert_not_awaited()
        render.assert_awaited_once()
        np.testing.assert_array_equal(render.call_args.args[-1], self.image)

    async def test_new_node_rebuilds_missing_cache_without_needing_text_provider(self):
        self.body.update(translations={}, language='en')
        with patch.object(server, 'erase_page', new=AsyncMock(return_value={'cleaned': self.image.copy()})) as erase, \
             patch.object(server, 'render_page', new=AsyncMock(return_value=self.rendered)) as render:
            result = await server.process('render', Request(self.body))
        self.assertTrue(result['cache_rebuilt'])
        erase.assert_awaited_once()
        render.assert_awaited_once()

    async def test_cache_scope_prevents_cross_task_reuse(self):
        with patch.object(server, 'erase_page', new=AsyncMock(return_value={'cleaned': self.image.copy()})):
            painted = await server.process('inpaint', Request(self.body))
        self.body.update(scope='task-2', cache_key=painted['cache_key'], translations={}, language='en')
        with patch.object(server, 'erase_page', new=AsyncMock(return_value={'cleaned': self.image.copy()})) as erase, \
             patch.object(server, 'render_page', new=AsyncMock(return_value=self.rendered)):
            result = await server.process('render', Request(self.body))
        self.assertTrue(result['cache_rebuilt'])
        erase.assert_awaited_once()

    async def test_checkpoint_limit_rejected_before_device_execution(self):
        self.body['analysis'] = {'text': 'x' * server.MAX_CHECKPOINT}
        with patch.object(server, 'erase_page', new=AsyncMock()) as erase:
            result = await server.process('inpaint', Request(self.body))
        self.assertEqual(result.status_code, 422)
        erase.assert_not_awaited()

    async def test_old_version_rejected_before_running_a_stage(self):
        self.body['config']['version'] = 'mit-95227a2-classic-v2-crops'
        with patch.object(server, 'erase_page', new=AsyncMock()) as erase:
            with self.assertRaises(HTTPException) as error:
                await server.process('inpaint', Request(self.body))
        self.assertEqual(error.exception.status_code, 409)
        erase.assert_not_awaited()

    async def test_original_and_cleaned_arrays_reused_without_decode(self):
        with patch.object(server, 'erase_page', AsyncMock(return_value={'cleaned': self.image.copy()})):
            painted = await server.process('inpaint', Request(self.body))
        self.body.pop('image')
        self.body.update(image_ref=painted['image_ref'], input_hash=painted['input_hash'],
                         cache_key=painted['cache_key'], translations={}, language='en')
        with patch.object(server, 'decode', side_effect=AssertionError('unnecessary PNG decode')), \
             patch.object(server, 'erase_page', AsyncMock()) as erase, \
             patch.object(server, 'render_page', AsyncMock(return_value=self.rendered)) as render:
            result = await server.process('render', Request(self.body))
        self.assertFalse(result['cache_rebuilt'])
        erase.assert_not_awaited()
        np.testing.assert_array_equal(render.call_args.args[0], self.image)
        np.testing.assert_array_equal(render.call_args.args[-1], self.image)

    async def test_evicted_reference_fails_before_inference_and_cannot_cross_scope(self):
        with patch.object(server, 'analyze', AsyncMock(return_value={'segments': []})):
            analyzed = await server.process('analyze', Request(self.body))
        self.body.pop('image')
        self.body.update(image_ref=analyzed['image_ref'], input_hash=analyzed['input_hash'])
        with patch.object(server, 'analyze', AsyncMock()) as analyze:
            wrong = {**self.body, 'scope': 'other-owner-job'}
            response = await server.process('analyze', Request(wrong))
            self.assertEqual(response.status_code, 422)
            server.cache.entries.clear(); server.cache.size = 0
            response = await server.process('analyze', Request(self.body))
            self.assertEqual(response.status_code, 410)
            self.assertEqual(json.loads(response.body)['error'], 'ENGINE_INPUT_CACHE_MISS')
            analyze.assert_not_awaited()

    async def test_parallel_transport_cannot_overlap_two_image_stages(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def erase(*args, **kwargs):
            entered.set()
            await release.wait()
            return {'cleaned': self.image.copy()}

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

    async def test_png_encoding_releases_device(self):
        entered, release = Event(), Event()
        def encode(result):
            entered.set()
            assert release.wait(5)
            return {'image': 'encoded'}
        with patch.object(server, 'erase_page', AsyncMock(return_value={'cleaned': self.image.copy()})), \
             patch.object(server, 'render_page', AsyncMock(return_value=self.rendered)), \
             patch.object(server, 'encode_render', encode), \
             patch.object(server, 'analyze', AsyncMock(return_value={})) as analyze:
            rendering = asyncio.create_task(server.process('render', Request({**self.body, 'translations': {}, 'language': 'en'})))
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 3))
                await asyncio.wait_for(server.process('analyze', Request(self.body)), 2)
                analyze.assert_awaited_once()
            finally:
                release.set()
                await rendering


if __name__ == '__main__':
    unittest.main()
