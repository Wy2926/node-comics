from conftest import quota_usage
from conftest import run_job, claim_job
import base64
from datetime import timedelta
from io import BytesIO
import json
import socket
import httpx
import pytest
from sqlalchemy import func, select
from conftest import create, login_plus as login, upload


def test_cleanup_advances_past_200_tombstones(client, png):
    from app.assets import create_asset, object_path
    from app.db import session_factory
    from app.dispatcher import cleanup
    from app.models import Asset, now
    auth = login(client)
    owner = client.get("/v1/me", headers=auth).json()["user"]["id"]
    with session_factory()() as db:
        ids = []
        for _ in range(205):
            asset = create_asset(db, owner, png)
            asset.deleted_at = now()
            ids.append(asset.id)
        db.commit()
        cleanup(db)
        db.commit()
        assert db.scalar(select(func.count()).select_from(Asset).where(Asset.purged_at.is_not(None))) == 200
        cleanup(db)
        db.commit()
        assert db.scalar(select(func.count()).select_from(Asset).where(Asset.purged_at.is_not(None))) == 205
        assert all(not object_path(db.get(Asset, asset_id).storage_key).exists() for asset_id in ids)


def test_ready_stage_survives_reinitialization_without_recreating_job(client, png):
    from app.db import session_factory
    from app.db import initialize
    from app.models import Job
    from app.queue_models import JobStage
    auth = login(client)
    job_id = create(client, auth, upload(client, auth, png)).json()["id"]
    initialize()
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(Job)) == 1
        assert db.scalar(select(JobStage.status).where(JobStage.job_id == job_id)) == "ready"
    assert claim_job(job_id)


def test_chunked_body_rejected_before_unlimited_spool(client):
    from app.config import settings
    settings().max_upload_bytes = 100
    auth = login(client)
    # No content-length: the ASGI receiver must bound streamed multipart bytes.
    headers = {**auth, "Content-Type": "multipart/form-data; boundary=test-boundary"}
    def chunks():
        yield b'--test-boundary\r\nContent-Disposition: form-data; name="image"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n'
        yield b"x" * (1024 * 1024 + 200)
        yield b"\r\n--test-boundary--\r\n"
    response = client.put("/v1/translations/11111111-1111-4111-8111-111111111111", headers=headers, content=chunks())
    assert response.status_code == 413, response.text


def test_provider_socket_connects_to_validated_ip_without_second_dns(client, monkeypatch):
    import httpcore
    from app.adapters.transport import CheckedBackend
    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))])
    connected = []
    monkeypatch.setattr(httpcore.SyncBackend, "connect_tcp", lambda self, host, port, **kwargs: connected.append((host, port)) or "stream")
    assert CheckedBackend().connect_tcp("provider.example", 443) == "stream"
    assert connected == [("93.184.216.34", 443)]


def test_provider_socket_rejects_dns_rebinding_at_actual_connect(client, monkeypatch):
    from app.adapters.transport import CheckedBackend
    from app.errors import ProcessingError
    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))])
    with pytest.raises(ProcessingError):
        CheckedBackend().connect_tcp("previously-public.example", 443)


def test_checked_transport_streams_real_http_multipart_to_isolated_server(client, png):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread
    from app.adapters.transport import CheckedTransport
    from app.config import settings
    captured = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            captured.append((self.path, self.headers.get("User-Agent"), self.rfile.read(int(self.headers["Content-Length"]))))
            payload = json.dumps({"data": [{"b64_json": base64.b64encode(png).decode()}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        settings().allow_private_providers = True
        with httpx.Client(transport=CheckedTransport(allow_private=True)) as transport:
            result = transport.post(f"http://127.0.0.1:{server.server_port}/v1/images/edits", headers={"User-Agent": "Mozilla/5.0"}, files={"image": ("comic.png", png, "image/png")})
        assert result.status_code == 200
        assert captured[0][0:2] == ("/v1/images/edits", "Mozilla/5.0")
        assert b'name="image"; filename="comic.png"' in captured[0][2]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_expired_cancelled_page_releases_slot_after_input_was_purged(client, png):
    from app.config import settings
    from app.db import session_factory
    from app.models import Asset, Job, now
    from app.queue_models import ComputeNode, JobStage, ExecutionLease
    from app.scheduler import claim_stage
    from app.jobs import cancel_job
    from app.dispatcher import recover_lease
    from conftest import create, login_plus, upload
    from datetime import timedelta
    settings().classic_enabled = True
    auth = login_plus(client)
    job_id = create(client, auth, upload(client, auth, png), mode='classic').json()['id']
    with session_factory()() as db:
        job = db.get(Job, job_id)
        stage = db.scalar(select(JobStage).where(JobStage.job_id == job_id))
        db.add(ComputeNode(id='cancelled-page', name='cancelled page', resource_id='cancelled-page',
            capabilities=['page'], capacity=1, engine_version='fixture-build',
            supported_languages=['zh-Hans'], device='cpu'))
        db.flush()
        stage.status, stage.generation = 'running', 1
        from app.models import Attempt
        attempt = Attempt(job_id=job_id, provider_id=job.config['text']['provider_id'], lease_expires_at=now()+timedelta(minutes=1))
        db.add(attempt)
        db.flush()
        job.attempt_id = attempt.id
        job.status = 'running'
        lease = ExecutionLease(job_id=job_id, stage_id=stage.id, node_id='cancelled-page', owner_id=job.owner_id,
            generation=1, resource_pool='page', mode='classic',
            expires_at=now()-timedelta(seconds=1),
            limits={'deadline_at': (now()+timedelta(minutes=1)).isoformat()+'Z'})
        db.add(lease)
        db.flush()
        lease_id = lease.id
        cancel_job(db, job)
        from app.assets import object_path
        source = db.get(Asset, job.input_asset_id)
        object_path(source.storage_key).unlink()
        source.purged_at = now()
        db.commit()
    recover_lease(lease_id)
    with session_factory()() as db:
        assert db.get(ExecutionLease, lease_id).completed_at
        assert db.get(Job, job_id).status == 'cancelled'
