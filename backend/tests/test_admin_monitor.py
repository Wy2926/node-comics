import pytest
from datetime import timedelta
from sqlalchemy import select
from conftest import login, login_plus, upload, create
from admin_fixture import seed, DONE_ID, CACHE_ID, EXPIRED_ID


@pytest.fixture
def monitor(client):
    from app.db import session_factory
    from app.config import settings
    auth = login(client, settings().dev_admin_username)
    with session_factory()() as db:
        data = seed(db)
    return client, auth, data


@pytest.mark.parametrize("path", ["overview", "tasks", "tasks/"+DONE_ID, "nodes", "users", "users/20000000-0000-4000-8000-000000000000"])
def test_admin_permissions(client, path):
    assert client.get("/v1/admin/monitor/"+path).status_code == 401
    assert client.get("/v1/admin/monitor/"+path, headers=login(client, "reader")).status_code == 403


def test_parallel_timings_and_final_delivery_node(monitor):
    client, auth, _ = monitor
    result = client.get("/v1/admin/monitor/tasks/"+DONE_ID, headers=auth)
    assert result.status_code == 200, result.text
    data = result.json()
    assert data["elapsed_seconds"] == 120
    assert data["execution_seconds"] == 70
    assert data["worker_seconds"] == 100
    assert data["non_execution_seconds"] == 50
    assert data["initial_wait_seconds"] == 10
    assert data["completed_by"]["node_id"] == "gpu-b"
    assert len(data["nodes"]) == 3
    assert next(e for e in data["executions"] if e["stage"] == "text")["executor_id"] == "control-host:1234"
    assert data["text_cost_micros"] == 2000
    assert data["text_calls"][0]["seconds"] == 30
    assert "SHOULD_NOT_LEAK" not in result.text and "TOKEN_MUST_NOT_APPEAR" not in result.text
    assert not any(k in result.text for k in ['"config"', '"translations"', '"analysis"', '"storage_key"'])


def test_cached_and_expired_timings(monitor):
    client, auth, _ = monitor
    cache = client.get("/v1/admin/monitor/tasks/"+CACHE_ID, headers=auth).json()
    assert cache["execution_seconds"] == 0 and cache["completed_by"] is None
    expired = client.get("/v1/admin/monitor/tasks/"+EXPIRED_ID, headers=auth).json()
    assert expired["execution_seconds"] == 40 and expired["expired_leases"] == 1
    assert expired["running_nodes"] == [] and expired["executions"][0]["outcome"] == "expired"


def test_task_filter_pagination_and_no_duplicate_nodes(monitor):
    client, auth, data = monitor
    first = client.get("/v1/admin/monitor/tasks?limit=10", headers=auth).json()
    second = client.get("/v1/admin/monitor/tasks?limit=10&offset=10", headers=auth).json()
    assert first["total"] == 45 and first["next_offset"] == 10
    assert not {j["id"] for j in first["items"]} & {j["id"] for j in second["items"]}
    nodes = client.get("/v1/admin/monitor/tasks?node_id=gpu-a", headers=auth).json()
    assert nodes["total"] == 1 and nodes["items"][0]["id"] == DONE_ID
    assert client.get("/v1/admin/monitor/tasks?q=000000000001",headers=auth).json()["total"] == 1
    assert client.get("/v1/admin/monitor/tasks?q=%25",headers=auth).json()["total"] == 0
    filtered = client.get("/v1/admin/monitor/tasks", params={"owner_id":data["readers"][1],"mode":"classic","status":"queued"}, headers=auth).json()
    assert filtered["items"] and all(j["queue_paused"] for j in filtered["items"])
    assert client.get("/v1/admin/monitor/tasks?limit=101", headers=auth).status_code == 422
    assert client.get("/v1/admin/monitor/tasks?status=made-up", headers=auth).status_code == 422


def test_overview_counts_paused_and_nodes_without_storage(monitor, monkeypatch):
    from app.storage import get_store
    def reject(*a, **kw): raise AssertionError("admin metadata must not read object storage")
    store = get_store("local")
    for method in ("get", "read", "head", "exists", "access", "sign"):
        if hasattr(store, method): monkeypatch.setattr(type(store), method, reject)
    client, auth, _ = monitor
    overview = client.get("/v1/admin/monitor/overview", headers=auth).json()
    assert overview["users"] == {"total":5,"plus":1,"submitted_24h":4}
    assert overview["nodes"] == {"total":5,"online_enabled":3}
    assert overview["leases"] == {"expired":1,"running":1}
    assert any(q["paused"] and q["count"] > 0 for q in overview["queues"])
    nodes = client.get("/v1/admin/monitor/nodes", headers=auth).json()["items"]
    gpu_b = next(n for n in nodes if n["id"] == "gpu-b")
    assert not gpu_b["online"] and gpu_b["occupied"] == gpu_b["expired_leases"] == 1
    assert next(n for n in nodes if n["id"] == "control-text")["kind"] == "control_pool"
    for path in ["tasks", "tasks/"+DONE_ID, "users", "users/20000000-0000-4000-8000-000000000000"]:
        assert client.get("/v1/admin/monitor/"+path,headers=auth).status_code == 200


def test_users_plan_search_and_read_only_entitlements(monitor):
    from app.db import session_factory
    from app.entitlement_models import QuotaPeriod
    from app.queue_models import UserModeQueue
    from sqlalchemy import func
    client, auth, _ = monitor
    plus = client.get("/v1/admin/monitor/users?plan=plus", headers=auth).json()
    assert plus["total"] == 1 and plus["items"][0]["name"] == "星野同学"
    assert client.get("/v1/admin/monitor/users?plan=free", headers=auth).json()["total"] == 4
    assert client.get("/v1/admin/monitor/users?q=星野", headers=auth).json()["total"] == 1
    with session_factory()() as db:
        before = [db.scalar(select(func.count()).select_from(t)) for t in (QuotaPeriod, UserModeQueue)]
    detail = client.get("/v1/admin/monitor/users/"+plus["items"][0]["id"], headers=auth).json()
    assert detail["entitlements"]["modes"]["classic"]["unlimited"]
    with session_factory()() as db:
        assert before == [db.scalar(select(func.count()).select_from(t)) for t in (QuotaPeriod, UserModeQueue)]
    assert client.get("/v1/admin/monitor/users/missing", headers=auth).status_code == 404
    assert client.get("/v1/admin/monitor/tasks/missing", headers=auth).status_code == 404


def test_retries_keep_each_execution_and_cap_recovered_duration(monitor):
    from app.db import session_factory
    from app.models import Job
    from app.queue_models import ExecutionLease, JobStage
    client, auth, data = monitor
    with session_factory()() as db:
        lease = db.scalar(select(ExecutionLease).where(ExecutionLease.job_id == EXPIRED_ID))
        lease.completed_at = data["at"]
        lease.outcome = "failed"
        job = db.get(Job, EXPIRED_ID)
        job.status, job.completed_at = "no_text", data["at"]
        stage = db.get(JobStage, lease.stage_id)
        stage.generation, stage.attempts, stage.status = 2, 2, "succeeded"
        db.add(ExecutionLease(stage_id=lease.stage_id, job_id=job.id, node_id="gpu-a", owner_id=job.owner_id,
            executor_id="gpu-a", generation=2, resource_pool="image", mode="classic", priority_class="preload",
            weight=1, estimated_seconds=20, started_at=data["at"]-timedelta(seconds=40),
            expires_at=data["at"]+timedelta(seconds=50), completed_at=data["at"]-timedelta(seconds=10), outcome="succeeded"))
        db.commit()
    result=client.get("/v1/admin/monitor/tasks/"+EXPIRED_ID, headers=auth).json()
    assert result["execution_seconds"] == 70
    assert len(result["executions"]) == 2
    assert result["executions"][0]["outcome"] == "failed"
    assert result["executions"][1]["generation"] == 2
    assert result["completed_by"]["node_id"] == "gpu-a"
    assert result["expired_leases"] == 0


def test_control_claim_records_executor(client, png):
    from app.db import session_factory
    from app.scheduler import claim_stage
    from conftest import control_node
    auth=login_plus(client)
    job=create(client, auth, upload(client, auth, png)).json()
    with session_factory()() as db:
        node=control_node(db)
        lease=claim_stage(db, node, executor_id="host-a:4321")
        db.commit()
        assert lease.executor_id == "host-a:4321" and lease.job_id == job["id"]


def test_shell_and_static_assets(client):
    from app.admin_web import ROOT
    if not (ROOT / "index.html").is_file():
        pytest.skip("Build admin-ui before checking production assets")
    response=client.get("/admin/")
    assert response.status_code == 200
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert response.headers["cache-control"] == "private, no-store"
    assert "SHOULD_NOT_LEAK" not in response.text
    import re
    for asset in re.findall(r'(?:src|href)="(/admin/assets/[^\"]+)"', response.text):
        assert client.get(asset).status_code == 200
    assert client.get("/admin/assets/secret.env").status_code == 404
