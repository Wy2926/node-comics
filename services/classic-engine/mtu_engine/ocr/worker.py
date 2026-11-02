"""Persistent MLX recognition in an isolated environment; private bounded stdio."""
import argparse
import base64
from contextlib import redirect_stdout
from io import BytesIO
import json
from pathlib import Path
import sys

from .mlx import MAX_REQUEST

MAX_TOKENS = 512


class XiaomiModel:
    def __init__(self, model):
        import mlx.core as mx
        from mlx_vlm import load
        from transformers.models.qwen3_vl.processing_qwen3_vl import Qwen3VLProcessor

        if not mx.metal.is_available():
            raise RuntimeError('MLX Metal is unavailable')
        mx.set_default_device(mx.gpu)
        self.model, self.generation_processor = load(str(model), trust_remote_code=False)
        self.model.eval()
        # MLX-VLM replaces AutoProcessor; explicitly preserve the original HF preprocessing.
        self.processor = Qwen3VLProcessor.from_pretrained(model, local_files_only=True)
        self.processor.tokenizer.padding_side = 'left'
        mx.synchronize()
        mx.clear_cache()

    def recognize(self, images):
        import mlx.core as mx
        from mlx_vlm.generate.ar import BatchGenerator, _split_prompt_kwargs_per_row

        mx.synchronize()
        messages = [[{'role': 'user', 'content': [
            {'type': 'image', 'image': image},
            {'type': 'text', 'text': 'Extract the text in the image.'}]}] for image in images]
        tensors = self.processor.apply_chat_template(messages, tokenize=True, return_dict=True,
            return_tensors='pt', processor_kwargs={'padding': True},
            add_generation_prompt=True, enable_thinking=False)
        inputs = {key: mx.array(value.numpy()) for key, value in tensors.items()}
        ids, mask = inputs['input_ids'], inputs['attention_mask']
        features = self.model.get_input_embeddings(
            ids, inputs['pixel_values'], mask=mask, image_grid_thw=inputs['image_grid_thw'])
        prompt_kwargs = _split_prompt_kwargs_per_row(
            {key: value for key, value in features.to_dict().items() if value is not None}, len(images))
        generator = BatchGenerator(self.model.language_model, self.generation_processor,
            prefill_batch_size=len(images), completion_batch_size=len(images),
            prefill_step_size=None, compute_logprobs=False, greedy_sampling=True)
        try:
            uids = generator.insert(ids, MAX_TOKENS, prompt_kwargs=prompt_kwargs, attention_mask=mask)
            sequences, endings = {uid: [] for uid in uids}, {}
            while generator.has_work:
                _, responses = generator.next()
                for response in responses:
                    sequences[response.uid].append(response.token)
                    if response.finish_reason:
                        endings[response.uid] = response.finish_reason
            mx.synchronize()  # Finish the batch before releasing generator state.
            # A truncated paragraph must not authorize erasing unseen text.
            return [self.processor.tokenizer.decode(sequences[uid], skip_special_tokens=True).strip()
                    if endings.get(uid) == 'stop' else '' for uid in uids]
        finally:
            generator.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--threads', type=int, default=2)
    args = parser.parse_args()
    output = sys.stdout

    def send(value):
        output.write(json.dumps(value, ensure_ascii=False) + '\n')
        output.flush()

    try:
        with redirect_stdout(sys.stderr):
            from importlib.metadata import version
            import torch
            from PIL import Image
            from .models import verify_mlx
            torch.set_num_threads(args.threads)
            identity = verify_mlx(args.model)
            identity['versions'] = {name: version(name) for name in (
                'mlx', 'mlx-metal', 'mlx-vlm', 'torch', 'torchvision', 'transformers', 'tokenizers', 'Pillow')}
            reader = XiaomiModel(args.model)
        send({'identity': identity})
        for request in iter(lambda: sys.stdin.buffer.readline(MAX_REQUEST + 1), b''):
            if len(request) > MAX_REQUEST or not request.endswith(b'\n'):
                raise ValueError('Request too large')
            images = []
            for encoded in json.loads(request):
                with Image.open(BytesIO(base64.b64decode(encoded, validate=True))) as image:
                    images.append(image.convert('RGB'))
            with redirect_stdout(sys.stderr):
                texts = reader.recognize(images)
            send({'texts': texts})
    except Exception:
        # No traceback, source text, crops or signed paths enter node logs.
        send({'error': 'MLX_OCR_FAILED'})
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
