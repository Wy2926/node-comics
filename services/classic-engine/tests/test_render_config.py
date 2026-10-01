import json
from pathlib import Path

import pytest

from classic_node.config import load


@pytest.mark.parametrize('workers', [0, -1, 17, 9, True, 1.5, '2'])
def test_invalid_render_capacity_is_rejected(tmp_path, workers):
    config = json.loads((Path(__file__).parents[1] / 'node.example.json').read_text())
    config['render_workers'] = workers
    path = tmp_path / 'node.json'
    path.write_text(json.dumps(config))
    with pytest.raises(ValueError, match='render_workers'):
        load(path)


def test_render_capacity_defaults_to_one(tmp_path):
    config = json.loads((Path(__file__).parents[1] / 'node.example.json').read_text())
    config.pop('render_workers')
    path = tmp_path / 'node.json'
    path.write_text(json.dumps(config))
    assert load(path)['render_workers'] == 1
