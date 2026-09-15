"""Validate cache preservation at first/intermediate/final decoder positions."""
import copy
import os
import unittest

import torch
from manga_translator.ocr.model_48px import OCR
from ocr_directml import decoder_forward


class DecoderCacheTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.manual_seed(714)
        cls.network = OCR(['<pad>', '<s>', '</s>', 'a'], max_len=64).eval()

    def inputs(self):
        generator = torch.Generator().manual_seed(219)
        return (torch.randn(2, 1, 320, generator=generator),
                torch.randn(2, len(self.network.decoders)+1, 4, 320, generator=generator),
                torch.randn(2, 5, 320, generator=generator),
                torch.tensor([[False, False, False, True, True], [False]*5]))

    def check_decoder(self, candidate, device):
        for step in (0, 1, 3):
            with self.subTest(step=step), torch.no_grad():
                args = self.inputs()
                expected = self.network.decoder_forward(*[x.clone() for x in args], step)
                actual = decoder_forward(candidate, *[x.to(device) for x in args], step)
                torch.testing.assert_close(actual[0].cpu(), expected[0], atol=1e-5, rtol=1e-5)
                torch.testing.assert_close(actual[1].cpu(), expected[1], atol=1e-5, rtol=1e-5)
                # Future cache entries must remain untouched, including nonzero data.
                torch.testing.assert_close(actual[1].cpu()[:, :, step+1:], args[1][:, :, step+1:], atol=0, rtol=0)

    def test_equivalent_cache_updates_on_cpu(self):
        self.check_decoder(self.network, 'cpu')

    @unittest.skipUnless(os.name == 'nt', 'DirectML requires Windows')
    def test_equivalent_cache_updates_on_directml(self):
        try:
            import torch_directml
        except ImportError:
            self.skipTest('DirectML is not installed')
        if not torch_directml.device_count():
            self.skipTest('No DirectML adapter')
        # The decoder is all that executes here. Keep unused visual weights on CPU.
        network = copy.deepcopy(self.network)
        device = torch_directml.device(0)
        network.decoders.to(device)
        self.check_decoder(network, device)


if __name__ == '__main__':
    unittest.main()
