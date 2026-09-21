from pathlib import Path
import threading
import cv2
import ncnn
import numpy as np


def devices():
    return [{"index": i, "name": ncnn.get_gpu_info(i).device_name(),
             "vendor_id": ncnn.get_gpu_info(i).vendor_id()}
            for i in range(ncnn.get_gpu_count())]


class Network:
    """One synchronized NCNN network; numpy buffers outlive borrowed Mat views."""
    def __init__(self, path, gpu=0, threads=2):
        self.net = ncnn.Net()
        self.lock = threading.Lock()
        self.net.opt.num_threads = threads
        self.net.opt.use_vulkan_compute = gpu >= 0
        self.net.opt.use_fp16_packed = False
        self.net.opt.use_fp16_storage = False
        self.net.opt.use_fp16_arithmetic = False
        if gpu >= 0:
            if gpu >= ncnn.get_gpu_count():
                raise RuntimeError(f"Vulkan device {gpu} unavailable; found {devices()}")
            self.net.set_vulkan_device(gpu)
        path = Path(path)
        if self.net.load_param(str(path)) or self.net.load_model(str(path.with_suffix('.bin'))):
            raise RuntimeError(f"Cannot load NCNN model {path}")

    def run(self, inputs, outputs):
        buffers = {k: np.ascontiguousarray(v, dtype=np.float32) for k, v in inputs.items()}
        with self.lock, self.net.create_extractor() as ex:
            for name, array in buffers.items():
                if ex.input(name, ncnn.Mat(array)):
                    raise RuntimeError(f"NCNN input failed: {name}")
            result = []
            for name in outputs:
                code, mat = ex.extract(name)
                if code:
                    raise RuntimeError(f"NCNN extract failed: {name} ({code})")
                value = np.array(mat, copy=True)
                if not value.size or not np.isfinite(value).all():
                    raise RuntimeError(f"Invalid NCNN output: {name}")
                result.append(value)
            return result


def detector_input(rgb, size=1024):
    h, w = rgb.shape[:2]
    ratio = size / max(h, w)
    nh, nw = max(1,round(h * ratio)), max(1,round(w * ratio))
    canvas = np.zeros(((nh + 255) // 256 * 256, (nw + 255) // 256 * 256, 3), np.uint8)
    canvas[:nh, :nw] = cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_LINEAR)
    return (canvas.astype(np.float32) / 127.5 - 1).transpose(2, 0, 1), ratio


def detector_output(db, seg, rgb_shape, input_shape, ratio):
    h, w = rgb_shape[:2]
    ih, iw = input_shape[-2:]
    prob = 1 / (1 + np.exp(-np.clip(db[0], -80, 80)))
    count, labels, stats, _ = cv2.connectedComponentsWithStats((prob > .5).astype(np.uint8), 8)
    sums = np.bincount(labels.ravel(), weights=prob.ravel(), minlength=count)
    quads = []
    for i in range(1, count):
        x, y, bw, bh, area = stats[i]
        if sums[i] / area < .7 or bw < 3 or bh < 3:
            continue
        ys, xs = np.nonzero(labels[y:y+bh, x:x+bw] == i)
        center, (rw, rh), angle = cv2.minAreaRect(np.column_stack((xs+x, ys+y)).astype(np.float32))
        if min(rw, rh) < 3:
            continue
        d = rw * rh * 2.3 / (2 * (rw + rh))
        quad = cv2.boxPoints((center, (rw+2*d, rh+2*d), angle)) / ratio
        quad[:, 0] = quad[:, 0].clip(0, w-1)
        quad[:, 1] = quad[:, 1].clip(0, h-1)
        quads.append(quad)
    seg = seg.squeeze()
    sh, sw = seg.shape
    valid = seg[:max(1, round(h*ratio*sh/ih)), :max(1, round(w*ratio*sw/iw))]
    mask = (cv2.resize(valid, (w, h)) > .12).astype(np.uint8)*255
    return quads, mask
