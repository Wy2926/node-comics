"""Shared control capacity: initialized once, then owned by administrators."""
from .config import settings
from .models import now
from .queue_models import ComputeNode
from .scheduler import lock_scheduler

POOL_LIMITS = {'text': 100, 'redraw': 100, 'validate_upload': 32}
POOL_LABELS = {'text': '文本翻译', 'redraw': 'AI 重绘', 'validate_upload': '上传校验'}


def initialize_pools(db):
    cfg = settings()
    defaults = {'text': cfg.cluster_text_slots, 'redraw': cfg.cluster_redraw_slots,
                'validate_upload': cfg.cluster_upload_slots}
    lock_scheduler(db)
    for stage, slots in defaults.items():
        node_id = 'control-' + stage
        if db.get(ComputeNode, node_id) is None:
            db.add(ComputeNode(id=node_id, name=POOL_LABELS[stage], resource_id=node_id,
                capabilities=[stage], capacity=slots, engine_version='control', device='network',
                heartbeat_at=None, desired_config={'execution_slots': slots}, applied_config_version=1))
    db.commit()


def report_pools(db):
    """Heartbeat even disabled/full pools; capacity is never overwritten by workers."""
    lock_scheduler(db)
    for stage in POOL_LIMITS:
        node = db.get(ComputeNode, 'control-' + stage)
        node.heartbeat_at = now()
    db.commit()
