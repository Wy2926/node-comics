"""One local MLX worker isolates its runtime from the classic node environment."""
import base64
from io import BytesIO
import json
import os
from pathlib import Path
import selectors
import subprocess
from threading import Lock
from time import monotonic

from PIL import Image

from classic_node.timing import stage, waiting_for
from . import Reading
from .crops import paragraph_box

MAX_REQUEST = 64 * 1024 * 1024
MAX_RESPONSE = 1024 * 1024


class MLXOCR:
    def __init__(self, python, model, threads=2, batch_size=4):
        # Resolving a venv executable's symlink would silently select its base environment.
        self.python, self.model = os.path.abspath(python), str(Path(model).resolve())
        self.batch_size = batch_size
        self.threads, self._lock, self._process = threads, Lock(), None
        self.identity = self._start()

    async def recognize(self, image, blocks, config):
        height, width = image.shape[:2]
        boxes = [paragraph_box(block.xyxy, width, height) for block in blocks]
        indices = sorted((i for i, (l, t, r, b) in enumerate(boxes)
                          if r > l and b > t and len(blocks[i].lines)),
                         key=lambda i: (boxes[i][2] - boxes[i][0]) * (boxes[i][3] - boxes[i][1]))
        results = [Reading([]) for _ in blocks]
        with stage('analyze_ocr'):
            for offset in range(0, len(indices), self.batch_size):
                owners = indices[offset:offset + self.batch_size]
                crops = [Image.fromarray(image[t:b, l:r]) for l, t, r, b in (boxes[i] for i in owners)]
                for i, text in zip(owners, self._recognize(crops), strict=True):
                    results[i] = Reading([text] + [''] * (len(blocks[i].lines) - 1),
                                         line_aligned=len(blocks[i].lines) == 1)
        return results

    async def warmup(self, image, config):
        self._recognize([Image.fromarray(image[:96, :192])])

    def _start(self):
        environment = os.environ | {'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
            'TOKENIZERS_PARALLELISM': 'false', 'PYTHONPATH': str(Path(__file__).resolve().parents[2])}
        self._process = subprocess.Popen([self.python, '-m', 'mtu_engine.ocr.worker',
            '--model', self.model, '--threads', str(self.threads)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=environment)
        try:
            os.set_blocking(self._process.stdin.fileno(), False)
            os.set_blocking(self._process.stdout.fileno(), False)
            return self._exchange(None)['identity']
        except Exception:
            self.close()
            raise

    def _exchange(self, request, timeout=120):
        """Bound both pipe directions and time spent waiting for a crashed worker."""
        outgoing = memoryview(request or b'')
        received = bytearray()
        deadline = monotonic() + timeout
        with selectors.DefaultSelector() as poll:
            poll.register(self._process.stdout, selectors.EVENT_READ)
            if outgoing:
                poll.register(self._process.stdin, selectors.EVENT_WRITE)
            while True:
                remaining = deadline - monotonic()
                if remaining <= 0:
                    raise TimeoutError('MLX OCR worker timed out')
                for key, event in poll.select(remaining):
                    if event == selectors.EVENT_WRITE:
                        sent = os.write(key.fd, outgoing[:65536])
                        outgoing = outgoing[sent:]
                        if not outgoing:
                            poll.unregister(key.fileobj)
                    else:
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            raise RuntimeError('MLX OCR worker exited')
                        received.extend(chunk)
                        if len(received) > MAX_RESPONSE:
                            raise RuntimeError('MLX OCR response exceeded its limit')
                        if received.endswith(b'\n'):
                            response = json.loads(received)
                            if 'error' in response:
                                raise RuntimeError('MLX OCR worker failed')
                            return response

    def _recognize(self, crops):
        images = []
        for crop in crops:
            stream = BytesIO()
            crop.save(stream, format='PNG')
            images.append(base64.b64encode(stream.getvalue()).decode('ascii'))
        request = (json.dumps(images) + '\n').encode()
        if len(request) > MAX_REQUEST:
            raise ValueError('OCR crops exceed the local worker request limit')
        with waiting_for(self._lock, 'ocr_lock_wait'):
            try:
                if self._process is None or self._process.poll() is not None:
                    self.close()
                    if self._start() != self.identity:
                        raise RuntimeError('MLX OCR assets changed during execution')
                response = self._exchange(request)
                return response['texts']
            except Exception:
                # Do not replay this page or fall back to another recognizer.
                # The next independent page can start a fresh worker.
                self.close()
                raise

    def close(self):
        process, self._process = self._process, None
        if process is not None:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            process.stdin.close()
            process.stdout.close()
