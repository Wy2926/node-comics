"""Reading-order parity and bounded cleanup when a page produces no text/fails."""
from concurrent.futures import Future
import copy
import importlib
import unittest
from unittest.mock import AsyncMock, Mock, patch

import numpy as np

import server
from manga_translator.utils import TextBlock
from parallel_panels import sort_with_panels

upstream = importlib.import_module('manga_translator.utils.sort')


class PanelOrderTests(unittest.TestCase):
    def test_matches_original_for_panels_outliers_both_directions_and_empty_panels(self):
        regions = [TextBlock(lines=[[[x, y], [x+15, y], [x+15, y+20], [x, y+20]]],
                             texts=[str(i)]) for i, (x, y) in enumerate(
                                 [(10, 10), (120, 10), (130, 45), (15, 150), (240, 80)])]
        for rtl in (True, False):
            for panels in ([], [(0, 0, 100, 100), (100, 0, 100, 100), (0, 100, 200, 100)]):
                with self.subTest(rtl=rtl, panels=panels):
                    future = Future(); future.set_result(panels)
                    with patch.object(upstream, 'get_panels_from_array', return_value=panels):
                        expected = upstream.sort_regions(copy.deepcopy(regions), rtl, img=np.zeros((1, 1, 3)))
                    actual = sort_with_panels(copy.deepcopy(regions), future, rtl)
                    self.assertEqual([(r.text, r.panel_index) for r in actual],
                                     [(r.text, r.panel_index) for r in expected])

    def test_detector_failure_preserves_original_fallback(self):
        regions = [TextBlock(lines=[[[10, y], [30, y], [30, y+10], [10, y+10]]],
                             texts=[str(y)]) for y in (100, 10)]
        future = Future(); future.set_exception(ValueError('test'))
        actual = sort_with_panels(copy.deepcopy(regions), future, True)
        expected = upstream._simple_sort(regions, True)
        self.assertEqual([r.text for r in actual], [r.text for r in expected])


class PanelLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_panel_starts_before_detection_and_finishes_on_no_text(self):
        future = Mock()
        worker = Mock(); worker.submit.return_value = future

        async def detect(*args):
            worker.submit.assert_called_once()
            future.result.assert_not_called()
            return [], None, None

        with patch.object(server, 'panel_worker', worker), \
             patch.dict(server.models, detector=Mock(detect=AsyncMock(side_effect=detect))):
            result = await server.analyze(np.zeros((4, 4, 3), np.uint8), {'reading_order': 'rtl', 'detection_size': 256})
        self.assertEqual(result['segments'], [])
        future.result.assert_called_once()

    async def test_failed_page_drains_panel_without_masking_original_error(self):
        future = Mock(); future.result.side_effect = RuntimeError('panel failed')
        worker = Mock(); worker.submit.return_value = future
        with patch.object(server, 'panel_worker', worker), \
             patch.object(server, 'analyze_regions', AsyncMock(side_effect=ValueError('OCR failed'))):
            with self.assertRaisesRegex(ValueError, 'OCR failed'):
                await server.analyze(np.zeros((4, 4, 3), np.uint8), {'reading_order': 'rtl'})
        future.result.assert_called_once()
