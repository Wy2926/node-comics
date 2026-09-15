"""Private worker owned by benchmark_amd_parallel's physical-device reservation.

Do not use as a public node launcher. The parent owns the normal device lock for
the entire pool lifetime; each child has one bounded slot and its own model/cache.
"""
import os
from pathlib import Path
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/'services/classic-engine'), str(ROOT/'engines/mit-native')]


def main():
    import uvicorn
    import server
    from runtime import DeviceLock
    from mit_directml import DirectMLRuntime
    from ocr_directml import enable_gpu_ocr

    slot = int(os.environ['BENCHMARK_POOL_SLOT'])
    if not 0 <= slot < 4:
        raise RuntimeError('Invalid benchmark pool slot')
    if os.environ['BENCHMARK_GPU_OCR'] == '1':
        original_load = DirectMLRuntime.load
        original_evidence = DirectMLRuntime.evidence

        async def load(self, models):
            await original_load(self, models)
            enable_gpu_ocr(models['ocr'], self.device)

        def evidence(self):
            return {**original_evidence(self), 'ocr_decoder_device': str(self.device),
                    'ocr_cache_update': 'out-of-place-v1'}

        DirectMLRuntime.load, DirectMLRuntime.evidence = load, evidence
    # The physical resource_id stays unchanged. No fake GPU identities are
    # registered with the controller. Normal engines remain excluded by parent.
    server.lock = DeviceLock(server.RESOURCE_ID + ':benchmark-slot:' + str(slot),
                             os.environ['ENGINE_LOCK_DIR'])
    service = uvicorn.Server(uvicorn.Config(server.app, host='127.0.0.1',
                                           port=int(os.environ['BENCHMARK_PORT']), access_log=False))

    def watch():
        while not service.should_exit:
            if Path(os.environ['ENGINE_STOP_FILE']).exists():
                service.should_exit = True
                return
            time.sleep(.25)

    threading.Thread(target=watch, daemon=True).start()
    service.run()


if __name__ == '__main__':
    main()
