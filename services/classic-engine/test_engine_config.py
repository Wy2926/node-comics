"""Machine file parsing and transactional runtime application without GPU downloads."""
import asyncio
import json
import os
from unittest.mock import patch
import pytest
from pydantic import ValidationError
from engine_config import RuntimeConfig, MachineConfig, load


def test_file_languages_and_thread_settings_apply_before_model_import(tmp_path, monkeypatch):
    path = tmp_path / 'engine.json'
    path.write_text(json.dumps({'resource_id': 'test:cuda:0', 'device': 'cuda:0',
        'torch_interop_threads': 2, 'runtime': {'languages': ['ja', 'en'], 'torch_threads': 6, 'opencv_threads': 3}}))
    monkeypatch.setenv('ENGINE_CONFIG_FILE', str(path))
    with patch.dict(os.environ):
        runtime, interop = load()
        assert runtime.languages == ['ja', 'en'] and runtime.torch_threads == 6 and interop == 2
        assert os.environ['OMP_NUM_THREADS'] == '6'


@pytest.mark.parametrize('values', [{'languages': []}, {'languages': ['xx']}, {'torch_threads': 0},
                                   {'opencv_threads': True}, {'cache_bytes': -1}, {'unknown': 1}])
def test_invalid_runtime_rejected(values):
    with pytest.raises(ValidationError):
        RuntimeConfig.model_validate(values)


def test_neural_mode_is_local_validated_and_directml_is_explicitly_excluded(tmp_path, monkeypatch):
    values = {'resource_id': 'test:cuda:0', 'device': 'cuda:0', 'neural_acceleration': 'portable-v1'}
    path = tmp_path / 'engine.json'
    path.write_text(json.dumps(values))
    monkeypatch.setenv('ENGINE_CONFIG_FILE', str(path))
    with patch.dict(os.environ):
        load()
        assert os.environ['ENGINE_NEURAL_ACCELERATION'] == 'portable-v1'
    with pytest.raises(ValidationError):
        MachineConfig.model_validate({**values, 'profile': 'mit-directml'})
    with pytest.raises(ValidationError):
        MachineConfig.model_validate({**values, 'neural_acceleration': 'unknown'})


def test_failed_dictionary_preparation_does_not_publish_new_runtime():
    import server
    class Request:
        async def stream(self):
            yield b'{"languages": ["en"], "torch_threads": 7}'
    before = server.effective_runtime
    with patch.object(server, 'prepare_languages', side_effect=RuntimeError('checksum mismatch')):
        result = asyncio.run(server.configure(Request()))
    assert result.status_code == 422
    assert server.effective_runtime is before
