"""Bounded, credential-free parser subprocess entry point."""
from pathlib import Path
import sys

if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from comic_document_files import FileLimits, _child, _limit_child, normalize_pages


def probe(directory):
    """Exercise both native decoders in the same child used for file tasks."""
    import zipfile
    from PIL import Image
    root = Path(directory)
    _limit_child(FileLimits())
    with Image.new('RGB', (16, 16), 'white') as image:
        image.save(root / 'page.png')
        image.save(root / 'book.pdf', 'PDF')
    with zipfile.ZipFile(root / 'book.zip', 'w') as archive:
        archive.write(root / 'page.png', '1.png')
    for kind in ('pdf', 'zip'):
        pages = list(normalize_pages(root / ('book.' + kind), kind, root / kind))
        if len(pages) != 1 or pages[0]['page_index'] != 1:
            raise RuntimeError('DOCUMENT_PARSER_UNAVAILABLE')
    print('document-parser-ok')


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--probe':
        probe(sys.argv[2])
    else:
        _child()
