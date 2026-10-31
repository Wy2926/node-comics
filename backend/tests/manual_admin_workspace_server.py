"""Disposable admin workspace: local SQLite/Redis, synthetic IPs and LLM only."""
import os
from pathlib import Path
import sys

sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]
os.environ['SERVE_STATIC'] = 'true'
from fakeredis import FakeRedis
from app import redis_state
connection = FakeRedis(decode_responses=True)
redis_state.client = lambda: connection
from manual_admin_completion_server import app, port, session_factory
from app.adapters.llm import TextResponse
from app.translation_channels import CHANNELS, TranslationChannel
from app.models import Job, uid
from app.support_requests import SupportRequest
from app import admin_monitor
from sqlalchemy import select

# The demo never sends a model request or claims to resolve real geographic data.
channel = CHANNELS['openai']
CHANNELS['openai'] = TranslationChannel(channel.label, channel.config_type, channel.protocols,
    lambda *args, **kwargs: TextResponse('你好，世界！（本地模拟）', {'input_tokens': 24, 'output_tokens': 12}, None))
admin_monitor.countries = lambda addresses: {ip: {'code': country, 'status': 'located'}
    for ip in addresses if (country := {'203.0.113.20': 'JP', '2001:db8::10': 'US'}.get(ip))}
with session_factory()() as db:
    for index, job in enumerate(db.scalars(select(Job))):
        job.submitted_ip = '2001:db8::10' if index % 3 == 0 else '203.0.113.20'
    for kind, comment, contact in [
        ('plugin', '希望在阅读器里更方便地对照原图和译文。', 'reader@example.invalid'),
        ('uninstall', '暂时用不到，希望以后继续支持更多网站。', ''),
        ('website', '请支持这个漫画站点，目录很清晰。', '')]:
        db.add(SupportRequest(kind=kind, site_name='示例漫画站' if kind == 'website' else '',
            url='https://example.invalid/' if kind == 'website' else '', comment=comment, contact=contact,
            idempotency_key=uid(), request_hash='0' * 64))
    db.commit()
print('Workspace demo: all accounts, orders, IP countries and model responses are synthetic.', flush=True)
if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=port, access_log=False, log_level='warning')
