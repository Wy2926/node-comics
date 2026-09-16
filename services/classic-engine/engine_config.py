"""Local machine settings and validated live overrides (JSON, no executable config)."""
import json
import os
from pathlib import Path
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class RuntimeConfig(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    languages: list[Literal['zh-Hans', 'zh-Hant', 'ja', 'en', 'ko', 'fr', 'es', 'pt-BR', 'de', 'it', 'ru', 'pl', 'uk', 'tr', 'vi', 'id']] = Field(
        default_factory=lambda: ['zh-Hans', 'zh-Hant', 'ja', 'en', 'ko', 'fr', 'es', 'pt-BR', 'de', 'it', 'ru', 'pl', 'uk', 'tr', 'vi', 'id'], min_length=1, max_length=16)
    torch_threads: int = Field(default=4, ge=1, le=128)
    opencv_threads: int = Field(default=2, ge=1, le=128)
    cache_bytes: int = Field(default=256 * 1024**2, ge=0, le=8 * 1024**3)
    cache_ttl_seconds: int = Field(default=900, ge=0, le=86400)


class MachineConfig(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    schema_version: Literal[1] = 1
    profile: Literal['mit', 'mit-directml'] = 'mit'
    device: str = 'cpu'
    resource_id: str = Field(min_length=1, max_length=120)
    model_dir: str = '/models'
    font: str = '/opt/mit/fonts/NotoSansMonoCJK-VF.ttf.ttc'
    lock_dir: str = '/tmp/comics-device-locks'
    dictionary_dir: str | None = None
    torch_interop_threads: int = Field(default=1, ge=1, le=128)
    inpaint_workers: Literal[1, 2] = 1
    runtime: RuntimeConfig = Field(default_factory=RuntimeConfig)

    @model_validator(mode='after')
    def device_workers(self):
        if self.profile == 'mit' and self.inpaint_workers != 1:
            raise ValueError('Two crop workers are supported only by the DirectML profile')
        return self


def load():
    filename = os.environ.get('ENGINE_CONFIG_FILE')
    if filename:
        config = MachineConfig.model_validate(json.loads(Path(filename).read_text(encoding='utf-8')))
        mapping = {'profile': 'ENGINE_PROFILE', 'device': 'ENGINE_DEVICE', 'resource_id': 'ENGINE_RESOURCE_ID',
                   'model_dir': 'MODEL_DIR', 'font': 'ENGINE_FONT', 'lock_dir': 'ENGINE_LOCK_DIR',
                   'dictionary_dir': 'ENGINE_DICTIONARY_DIR', 'inpaint_workers': 'ENGINE_INPAINT_WORKERS'}
        for key, env in mapping.items():
            value = getattr(config, key)
            if value is not None:
                if key in {'model_dir', 'font', 'lock_dir', 'dictionary_dir'}:
                    value = (Path(filename).resolve().parent / value).resolve()
                os.environ[env] = str(value)
        runtime, interop = config.runtime, config.torch_interop_threads
    else:
        runtime = RuntimeConfig(
            torch_threads=int(os.environ.get('OMP_NUM_THREADS', '4')),
            opencv_threads=int(os.environ.get('ENGINE_OPENCV_THREADS', '2')),
            cache_bytes=int(os.environ.get('ENGINE_CACHE_BYTES', str(256 * 1024**2))),
            cache_ttl_seconds=int(os.environ.get('ENGINE_CACHE_TTL_SECONDS', '900')))
        interop = int(os.environ.get('ENGINE_TORCH_INTEROP_THREADS', '1'))
    os.environ['OMP_NUM_THREADS'] = str(runtime.torch_threads)
    os.environ['MKL_NUM_THREADS'] = str(runtime.torch_threads)
    os.environ['OPENBLAS_NUM_THREADS'] = str(runtime.torch_threads)
    os.environ['ENGINE_OPENCV_THREADS'] = str(runtime.opencv_threads)
    os.environ['ENGINE_TORCH_INTEROP_THREADS'] = str(interop)
    return runtime, interop
