"""Opt-in FIFO/legacy comparison using the same isolated PostgreSQL workload."""
import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from statistics import median
from time import perf_counter

import pytest
from sqlalchemy import insert, select, text

from app import scheduler
from app.db import session_factory
from app.models import Asset, Job, User, now
from app.queue_models import ComputeNode, ExecutionLease, JobStage
from app.storage import get_store
from test_classic_parallel_postgres import text_database
from test_cluster_scheduler import scheduler_case

pytestmark = pytest.mark.skipif(os.environ.get('RUN_SCHEDULER_SCALE') != '1',
    reason='Opt-in isolated PostgreSQL scheduling load measurement')


@pytest.mark.parametrize('pages', [1000, 50000])
@pytest.mark.parametrize('nodes', [1, 8, 32])
def test_claim_throughput(scheduler_case, pages, nodes):
    at = now()
    owners = 100
    with session_factory()() as db:
        db.execute(insert(User), [{'id': f'bench-user-{i}', 'subject': f'bench:{i}', 'name': 'bench',
            'plus_started_at': at - timedelta(days=1) if i % 4 == 0 else None,
            'plus_expires_at': at + timedelta(days=1) if i % 4 == 0 else None}
                                 for i in range(owners)])
        db.execute(insert(Asset), [{'id': f'bench-source-{i}', 'owner_id': f'bench-user-{i}',
            'sha256': 'a' * 64, 'storage_key': f'bench/{i}', 'mime': 'image/png',
            'width': 80, 'height': 64, 'byte_size': 100} for i in range(owners)])
        template = db.get(ComputeNode, 'node-0')
        for i in range(nodes):
            node = db.get(ComputeNode, f'node-{i}')
            if node is None:
                node = ComputeNode(id=f'node-{i}', name='bench', resource_id=f'bench:{i}',
                    engine_version=template.engine_version, device='fixture', capabilities=['page'],
                    supported_languages=['zh-Hans'])
                db.add(node)
            node.capacity = 4
        for start in range(0, pages, 1000):
            indexes = range(start, min(pages, start + 1000))
            db.execute(insert(Job), [{'id': f'bench-job-{i:06}', 'owner_id': f'bench-user-{i % owners}',
                'input_asset_id': f'bench-source-{i % owners}', 'source_sha256': 'a' * 64,
                'mode': 'classic', 'target_language': 'zh-Hans', 'status': 'queued',
                'quota_pages': 0, 'quota_kind': 'unlimited', 'settlement': 'free', 'config': scheduler_case,
                'operation': 'benchmark', 'request_hash': 'a' * 64, 'idempotency_key': str(i),
                'cache_key': f'{i:064x}', 'created_at': at} for i in indexes])
            db.execute(insert(JobStage), [{'id': f'bench-stage-{i:06}', 'job_id': f'bench-job-{i:06}',
                'name': 'page', 'status': 'ready', 'available_at': at} for i in indexes])
        db.commit()
        db.execute(text('ANALYZE'))
        db.commit()
    for i in range(owners):
        get_store().put(f'bench/{i}', b'fixture', 'image/png', kind='original')

    def claim(i):
        started = perf_counter()
        with session_factory()() as db:
            leases = scheduler.claim_batch(db, f'node-{i}', ['page'], limit=4)
            db.commit()
            # Match the public claim path's one bounded contention retry.
            if not leases and scheduler.has_claimable_work(db, f'node-{i}', ['page']):
                leases = scheduler.claim_batch(db, f'node-{i}', ['page'], limit=4)
                db.commit()
            return perf_counter() - started, [lease.id for lease in leases]

    times, empty, total, elapsed = [], 0, 0, 0
    with ThreadPoolExecutor(max_workers=nodes) as pool:
        for _ in range(6):
            started = perf_counter()
            replies = list(pool.map(claim, range(nodes)))
            elapsed += perf_counter() - started
            times.extend(duration for duration, _ in replies)
            empty += sum(not ids for _, ids in replies)
            ids = [key for _, keys in replies for key in keys]
            total += len(ids)
            with session_factory()() as db:
                scheduler.lock_scheduler(db)
                leases = db.scalars(select(ExecutionLease).where(ExecutionLease.id.in_(ids))).all()
                assert len({lease.stage_id for lease in leases}) == len(leases)
                for lease in leases:
                    scheduler.release_lease(db, lease, 'succeeded')
                    db.get(JobStage, lease.stage_id).status = 'succeeded'
                    db.get(Job, lease.job_id).status = 'succeeded'
                db.commit()
    report = {'pages': pages, 'nodes': nodes, 'claims': len(times), 'empty_claims': empty,
        'claimed_pages': total, 'claim_p50_ms': round(median(times) * 1000, 2),
        'claim_p95_ms': round(sorted(times)[max(0, int(len(times) * .95) - 1)] * 1000, 2),
        'pages_per_claim_second': round(total / elapsed, 2)}
    print(json.dumps(report))
    assert total > 0
