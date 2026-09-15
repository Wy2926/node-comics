"""Run with the engine image's Python; no models, network or extra test dependencies."""
import unittest
from unittest.mock import patch

import numpy as np

from local_inpainting import inpaint_regions, plan_regions


OPTIONS = dict(max_size=512, padding=48, merge_gap=24)


class CropTests(unittest.IsolatedAsyncioTestCase):
    async def test_small_text_uses_small_crop_and_preserves_background(self):
        image = np.full((2000, 1500, 3), 123, np.uint8)
        mask = np.zeros(image.shape[:2], np.uint8)
        mask[120:220, 1000:1150] = 255
        sizes = []

        async def predict(crop, crop_mask):
            sizes.append(crop.shape[:2])
            crop[:] = 220  # Deliberately corrupt even unmasked pixels.
            crop_mask[:] = 255
            return crop

        result = await inpaint_regions(image, mask, predict, **OPTIONS)
        self.assertEqual(sizes, [(196, 246)])
        np.testing.assert_array_equal(result[mask == 0], image[mask == 0])
        self.assertTrue(np.all(result[mask > 0] == 220))
        self.assertTrue(np.all(image == 123))
        self.assertEqual(np.count_nonzero(mask), 15000)

    async def test_empty_mask_skips_inference(self):
        image = np.zeros((300, 400, 3), np.uint8)

        async def forbidden(*args):
            self.fail('Empty masks must not run LaMa')

        result = await inpaint_regions(image, image[:, :, 0], forbidden, **OPTIONS)
        np.testing.assert_array_equal(result, image)

    def test_nearby_letters_merge_but_distant_bubbles_stay_separate(self):
        mask = np.zeros((1200, 1000), np.uint8)
        mask[100:120, 100:110] = 255
        mask[100:120, 120:130] = 255
        mask[900:940, 800:830] = 255
        regions = plan_regions(mask, **OPTIONS)
        self.assertEqual(len(regions), 2)
        self.assertEqual(regions[0][0], (100, 100, 130, 120))

    def assert_coverage(self, mask):
        owners = np.zeros(mask.shape, np.uint16)
        for core, crop in plan_regions(mask, **OPTIONS):
            x0, y0, x1, y1 = core
            a, b, c, d = crop
            self.assertTrue(0 <= a <= x0 < x1 <= c <= mask.shape[1])
            self.assertTrue(0 <= b <= y0 < y1 <= d <= mask.shape[0])
            self.assertLessEqual(max(c - a, d - b), OPTIONS['max_size'])
            owners[y0:y1, x0:x1] += mask[y0:y1, x0:x1] > 0
        np.testing.assert_array_equal(owners, (mask > 0).astype(np.uint16))

    def test_edges_and_large_dense_regions_have_one_owner_per_pixel(self):
        for shape in [(800, 1400), (2000, 80), (16, 2000), (2000, 16)]:
            with self.subTest(shape=shape):
                self.assert_coverage(np.full(shape, 255, np.uint8))

    def test_nested_component_rectangles_do_not_duplicate_pixels(self):
        mask = np.zeros((1000, 1000), np.uint8)
        mask[100:900, 100:120] = 255
        mask[100:120, 100:900] = 255
        mask[880:900, 100:900] = 255
        mask[100:900, 880:900] = 255
        mask[400:500, 400:500] = 255
        self.assert_coverage(mask)

    def test_many_disconnected_marks_remain_bounded_and_complete(self):
        mask = np.zeros((1000, 1000), np.uint8)
        mask[::32, ::32] = 255
        self.assert_coverage(mask)

    async def test_overlapping_contexts_always_read_original_and_are_order_independent(self):
        image = np.random.default_rng(7).integers(0, 256, (500, 700, 3), dtype=np.uint8)
        mask = np.zeros(image.shape[:2], np.uint8)
        mask[100:150, 100:150] = 255
        mask[100:150, 190:240] = 255
        plan = plan_regions(mask, **OPTIONS)
        self.assertEqual(len(plan), 2)
        self.assertGreater(plan[0][1][2], plan[1][1][0])

        async def run(order):
            calls = iter(order)

            async def predict(crop, crop_mask):
                _, (x0, y0, x1, y1) = next(calls)
                np.testing.assert_array_equal(crop, image[y0:y1, x0:x1])
                np.testing.assert_array_equal(crop_mask, mask[y0:y1, x0:x1])
                return np.full_like(crop, int(crop.mean()))

            with patch('local_inpainting.plan_regions', return_value=order):
                return await inpaint_regions(image, mask, predict, **OPTIONS)

        np.testing.assert_array_equal(await run(plan), await run(list(reversed(plan))))

    async def test_invalid_prediction_fails_without_modifying_source(self):
        image = np.full((200, 200, 3), 123, np.uint8)
        mask = np.full((200, 200), 255, np.uint8)

        async def invalid(crop, crop_mask):
            return crop[:-1]

        with self.assertRaisesRegex(ValueError, 'crop result'):
            await inpaint_regions(image, mask, invalid, **OPTIONS)
        self.assertTrue(np.all(image == 123))

    def test_invalid_crop_settings_rejected(self):
        mask = np.ones((200, 200), np.uint8)
        with self.assertRaisesRegex(ValueError, 'configuration'):
            plan_regions(mask, max_size=512, padding=256, merge_gap=24)


if __name__ == '__main__':
    unittest.main()
