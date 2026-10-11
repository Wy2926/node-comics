"""Opt-in real-kernel acceptance: NODE_TEST_SANDBOX=1 on the target host."""
import os
from pathlib import Path
import tempfile
import unittest
import zipfile


@unittest.skipUnless(os.environ.get('NODE_TEST_SANDBOX') == '1', 'requires real Linux sandbox host')
class ParserSandboxTests(unittest.TestCase):
    def test_denials_and_pdf_zip_normalization(self):
        from PIL import Image
        from comic_document_files import check_parser_sandbox, run_file_operation
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertTrue(check_parser_sandbox(root))
            with Image.new('RGB', (160, 240), 'white') as first, Image.new('RGB', (160, 240), 'blue') as second:
                first.save(root / 'one.png')
                second.save(root / 'two.png')
                first.save(root / 'book.pdf', 'PDF', save_all=True, append_images=[second])
            with zipfile.ZipFile(root / 'book.zip', 'w') as archive:
                archive.write(root / 'one.png', '1.png')
                archive.write(root / 'two.png', '2.png')
            for kind in ('zip', 'pdf'):
                with self.subTest(kind=kind):
                    source = root / ('book.' + kind)
                    manifest = run_file_operation('scan', source, kind)
                    pages = run_file_operation('normalize', source, kind, root / kind, manifest=manifest)
                    self.assertEqual([p['page_index'] for p in pages], [1, 2])
                    for page in pages:
                        with Image.open(page['path']) as image:
                            image.load()
                            self.assertEqual(image.format, 'PNG')


if __name__ == '__main__':
    unittest.main()
