"""Synthetic metadata for admin API and browser checks; no private images or model calls."""
from datetime import timedelta
from app.node_config import NodeConfig
from app.models import Attempt, Job, TextCall, User, now
from app.queue_models import ComputeNode, ExecutionLease, JobStage, UserModeQueue

DONE_ID = "10000000-0000-4000-8000-000000000001"
RUNNING_ID = "10000000-0000-4000-8000-000000000002"
CACHE_ID = "10000000-0000-4000-8000-000000000003"
EXPIRED_ID = "10000000-0000-4000-8000-000000000004"


def seed(db):
    at = now().replace(microsecond=0)
    readers = [User(id=f"20000000-0000-4000-8000-{i:012}", subject=f"fixture:{i}", name=name,
        created_at=at - timedelta(days=15-i)) for i, name in enumerate(["星野同学", "漫游读者", "绘梨", "青空"])]
    readers[0].plus_started_at = at - timedelta(days=2)
    readers[0].plus_expires_at = at + timedelta(days=28)
    readers[0].plus_timezone = "Asia/Shanghai"
    readers[0].plus_monthly_pages = 300
    readers[0].membership_id = "fixture-membership"
    db.add_all(readers)
    nodes = [ComputeNode(applied_config_version=1, supported_languages=['zh-Hans', 'zh-Hant', 'ja', 'en', 'ko'], id="gpu-a", name="绘图节点 A", resource_id="gpu-a-device", device="CUDA / GPU 0",
        engine_version="fixture-engine-v1", capabilities=["analyze", "inpaint", "render"], capacity=2, heartbeat_at=at),
        ComputeNode(applied_config_version=1, supported_languages=['zh-Hans', 'zh-Hant', 'ja', 'en', 'ko'], id="gpu-b", name="绘图节点 B", resource_id="gpu-b-device", device="DirectML / GPU 0",
        engine_version="fixture-engine-v1", capabilities=["analyze", "inpaint", "render"], capacity=1, heartbeat_at=at-timedelta(minutes=8)),
        ComputeNode(applied_config_version=1, supported_languages=['zh-Hans', 'zh-Hant', 'ja', 'en', 'ko'], id="control-text", name="control-text", resource_id="control-text", device="network",
        engine_version="control", capabilities=["text"], capacity=4, heartbeat_at=at),
        ComputeNode(applied_config_version=1, supported_languages=['zh-Hans', 'zh-Hant', 'ja', 'en', 'ko'], id="control-redraw", name="control-redraw", resource_id="control-redraw", device="network",
        engine_version="control", capabilities=["redraw"], capacity=4, heartbeat_at=at)]
    for node in nodes:
        node.desired_config = NodeConfig(execution_slots=node.capacity).model_dump(exclude_none=True)
    db.add_all(nodes); db.flush()
    db.add(UserModeQueue(owner_id=readers[1].id, mode="classic", paused=True))

    def job(i, status, mode="classic", owner=0, age=600):
        row = Job(id=f"10000000-0000-4000-8000-{i:012}", owner_id=readers[owner].id, mode=mode,
            target_language="zh-Hans", status=status, phase=status, idempotency_key=f"fixture-{i}", operation="admin-fixture",
            request_hash=f"{i:064x}", cache_key=f"{i:064x}", config={"provider": {"id": "fixture", "secret": "SHOULD_NOT_LEAK"}},
            quota_pages=1, quota_kind="classic_unlimited", settlement="reserved", created_at=at-timedelta(seconds=age), page_index=i-1,
            realtime_until=at+timedelta(minutes=30) if i%3 == 0 else None)
        if status in {"succeeded", "no_text", "failed", "cancelled", "unknown_released"}:
            row.completed_at = row.created_at + timedelta(seconds=120)
            row.settlement = "charged" if status == "succeeded" else "released"
        if status == "failed": row.error_code = "ENGINE_UNAVAILABLE"
        db.add(row); db.flush(); return row

    def execution(row, name, node, start, end, generation=1, expiry=None, outcome="succeeded"):
        stage = db.query(JobStage).filter_by(job_id=row.id, name=name).first()
        if not stage:
            stage = JobStage(job_id=row.id, name=name, status="succeeded" if end else "running", attempts=generation,
                             generation=generation, completed_at=row.created_at+timedelta(seconds=end) if end else None)
            db.add(stage); db.flush()
        lease = ExecutionLease(stage_id=stage.id, job_id=row.id, node_id=node, owner_id=row.owner_id, generation=generation,
            executor_id="control-host:1234" if node.startswith("control") else node,
            token="TOKEN_MUST_NOT_APPEAR", resource_pool="text" if name=="text" else "image", mode=row.mode,
            priority_class="preload", weight=1, estimated_seconds=20,
            started_at=row.created_at+timedelta(seconds=start),
            expires_at=expiry or at+timedelta(seconds=600),
            completed_at=row.created_at+timedelta(seconds=end) if end else None, outcome=outcome if end else None)
        db.add(lease); db.flush(); return lease

    completed = job(1, "succeeded")
    execution(completed, "analyze", "gpu-a", 10, 30)
    execution(completed, "text", "control-text", 40, 80)
    execution(completed, "inpaint", "gpu-a", 40, 70)
    execution(completed, "render", "gpu-b", 90, 100)
    attempt = Attempt(job_id=completed.id, provider_id="fixture-text", lease_expires_at=at+timedelta(seconds=600), cost_state="reported")
    db.add(attempt); db.flush(); completed.attempt_id=attempt.id
    db.add(TextCall(job_id=completed.id, attempt_id=attempt.id, group_index=0, sequence=1, provider_id="fixture-text",
        model="fixture-model", reserved_micros=6000, accounted_micros=2000, cost_state="reported",
        started_at=completed.created_at+timedelta(seconds=45), completed_at=completed.created_at+timedelta(seconds=75)))
    running=job(2,"running",age=50); running.phase="text"
    execution(running,"text","control-text",10,None)
    cache=job(3,"succeeded",age=400); cache.cache_hit=True
    expired=job(4,"running",age=300); expired.phase="analyze"
    execution(expired,"analyze","gpu-b",10,None,expiry=expired.created_at+timedelta(seconds=50))
    for i in range(5,46):
        status=["queued","queued","queued","awaiting_upload","validating_upload","failed","no_text","outcome_unknown"][i%8]
        row=job(i,status,mode="classic" if i%2 else "redraw",owner=i%4,age=800+i*10)
        if status=="queued": db.add(JobStage(job_id=row.id,name="analyze" if row.mode=="classic" else "redraw",status="ready"))
    db.commit()
    return {"at": at, "readers": [r.id for r in readers]}
