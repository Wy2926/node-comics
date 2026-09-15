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


def mock_transport(monkeypatch, handler):
    import app.adapters.images as adapter
    original = httpx.Client
    def mock_client(**kwargs):
        transport = kwargs.pop("transport", None)
        if transport:
            transport.close()
        return original(transport=httpx.MockTransport(handler), **kwargs)
    monkeypatch.setattr(adapter.httpx, "Client", mock_client)
    monkeypatch.setattr(adapter.socket, "getaddrinfo", lambda *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))])


def config_for_test():
    from app.db import session_factory
    from app.providers import configuration
    with session_factory()() as db:
        return configuration(db, "redraw", "zh-Hans")


def test_real_multipart_shape_model_profile_and_base64_decode(client, png, monkeypatch):
    from app.adapters.images import redraw
    calls = []
    def handler(request):
        calls.append(request)
        assert str(request.url) == "https://provider.example/v1/images/edits"
        assert request.headers["content-type"].startswith("multipart/form-data; boundary=")
        assert b'name="image"; filename="comic.png"' in request.content
        assert b'name="model"' in request.content and b"gpt-image-2" in request.content
        assert b"input_fidelity" not in request.content and b"response_format" not in request.content
        return httpx.Response(200, headers={"x-request-id": "request-42"}, json={"data": [{"b64_json": base64.b64encode(png).decode()}], "usage": {"total_tokens": 42, "private_text": "omit-me"}})
    mock_transport(monkeypatch, handler)
    result = redraw(png, "image/png", "zh-Hans", config_for_test())
    assert result.image == png and result.request_id == "request-42"
    assert result.usage == {"total_tokens": 42} and len(calls) == 1


@pytest.mark.parametrize("status,unknown,code", [(429, False, "PROVIDER_RATE_LIMITED"), (403, False, "PROVIDER_REJECTED"), (500, True, "UPSTREAM_OUTCOME_UNKNOWN"), (503, True, "UPSTREAM_OUTCOME_UNKNOWN")])
def test_http_errors_do_not_retry_and_preserve_acceptance_uncertainty(client, png, monkeypatch, status, unknown, code):
    from app.adapters.images import redraw
    from app.errors import ProcessingError
    calls = []
    def handler(request):
        calls.append(1)
        return httpx.Response(status, json={"error": "upstream raw response must never leak"})
    mock_transport(monkeypatch, handler)
    with pytest.raises(ProcessingError) as caught:
        redraw(png, "image/png", "zh-Hans", config_for_test())
    assert len(calls) == 1 and caught.value.unknown == unknown and caught.value.code == code
    assert "upstream raw" not in caught.value.message


def test_invalid_image_preserves_reported_usage(client, png, monkeypatch):
    from conftest import run_job as process_job
    from app.db import session_factory
    from app.models import Attempt, Job
    mock_transport(monkeypatch, lambda request: httpx.Response(200, headers={"x-request-id": "paid-invalid"}, json={"data": [{"b64_json": base64.b64encode(b"not a picture").decode()}], "usage": {"total_tokens": 100}}))
    auth = login(client)
    job_id = create(client, auth, upload(client, auth, png)).json()["id"]
    process_job(job_id)
    with session_factory()() as db:
        job = db.get(Job, job_id)
        attempt = db.get(Attempt, job.attempt_id)
        assert job.status == "failed" and job.settlement == "released"
        assert attempt.usage == {"total_tokens": 100} and attempt.cost_state == "reported"
        assert attempt.request_id == "paid-invalid"


def test_ratio_failure_preserves_reported_usage(client, png, monkeypatch):
    from PIL import Image
    import app.workers as workers
    from app.adapters.images import TranslationOutput
    from app.db import session_factory
    from app.models import Attempt, Job
    buffer = BytesIO()
    Image.new("RGB", (800, 100)).save(buffer, "PNG")
    monkeypatch.setattr(workers, "redraw", lambda *args: TranslationOutput(buffer.getvalue(), request_id="paid-cropped", usage={"total_tokens": 71}))
    auth = login(client)
    job_id = create(client, auth, upload(client, auth, png)).json()["id"]
    run_job(job_id)
    with session_factory()() as db:
        job = db.get(Job, job_id)
        attempt = db.get(Attempt, job.attempt_id)
        assert job.status == "failed" and attempt.usage == {"total_tokens": 71}


def test_expired_old_worker_cannot_write_call_intent_after_reclaim(client, png, monkeypatch):
    import app.workers as workers
    from app.db import session_factory
    from app.dispatcher import recover_lease
    from app.errors import ProcessingError
    from app.models import Attempt, Job, now
    from app.queue_models import ExecutionLease, JobStage
    auth = login(client)
    job_id = create(client, auth, upload(client, auth, png)).json()["id"]
    first_lease = claim_job(job_id)
    with session_factory()() as db:
        db.get(ExecutionLease, first_lease).expires_at = now() - timedelta(seconds=1)
        db.commit()
    recover_lease(first_lease)
    with session_factory()() as db:
        stage = db.get(JobStage, db.get(ExecutionLease, first_lease).stage_id)
        stage.available_at = now()
        db.commit()
    second_lease = claim_job(job_id)
    assert second_lease and second_lease != first_lease
    monkeypatch.setattr(workers, "redraw", lambda *args: pytest.fail("stale worker must not issue paid request"))
    with pytest.raises(ProcessingError, match="LEASE_EXPIRED"):
        workers.run_control_stage(first_lease)
    with session_factory()() as db:
        assert db.get(Attempt, db.get(Job, job_id).attempt_id).call_started_at is None
        assert db.get(ExecutionLease, second_lease).generation == 2


def test_saved_output_is_recovered_after_crash_before_database_commit(client, png):
    from app.storage import get_store
    from app.db import session_factory
    from app.dispatcher import recover_lease
    from app.models import Attempt, Job, now
    from app.queue_models import ExecutionLease
    from conftest import claim_job as claim
    auth = login(client)
    job_id = create(client, auth, upload(client, auth, png)).json()["id"]
    lease_id = claim(job_id)
    with session_factory()() as db:
        job = db.get(Job, job_id)
        attempt = db.get(Attempt, job.attempt_id)
        attempt.call_started_at = now() - timedelta(hours=1)
        db.get(ExecutionLease, lease_id).expires_at = now() - timedelta(seconds=1)
        db.commit()
        get_store(attempt.output_storage_backend).put(f"{job.owner_id}/{lease_id}", png, "image/png", kind="redraw")
    recover_lease(lease_id)
    recover_lease(lease_id)
    with session_factory()() as db:
        assert db.get(Job, job_id).status == "succeeded"
        assert db.get(Job, job_id).output_asset_id == lease_id
        assert db.get(Attempt, db.get(Job, job_id).attempt_id).recovered
    usage = quota_usage(client, auth)
    assert usage["used"] == 1 and usage["reserved"] == 0


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


def test_late_child_of_deleted_original_is_inaccessible_and_purged(client, png):
    from app.assets import create_asset, object_path
    from app.db import session_factory
    from app.dispatcher import cleanup
    from app.models import Asset
    auth = login(client)
    owner = client.get("/v1/me", headers=auth).json()["user"]["id"]
    original = upload(client, auth, png)
    assert client.delete(f"/v1/images/{original}", headers=auth).status_code == 200
    with session_factory()() as db:
        output = create_asset(db, owner, png, kind="redraw", parent_id=original)
        db.commit()
        output_id, path = output.id, object_path(output.storage_key)
    assert client.get(f"/v1/images/{output_id}/content", headers=auth).status_code == 410
    with session_factory()() as db:
        cleanup(db)
        db.commit()
        assert db.get(Asset, output_id).purged_at is not None and not path.exists()


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
    response = client.post("/v1/translation-submissions", headers=headers, content=chunks())
    assert response.status_code == 413, response.text


@pytest.mark.parametrize("url", ["https://127.0.0.1/private", "https://169.254.169.254/latest/meta-data", "https://[::1]/", "file:///etc/passwd", "https://user:password@example.com/picture"])
def test_result_url_blocks_private_network_and_credentials(client, url):
    from app.adapters.images import safe_endpoint
    from app.errors import ProcessingError
    with pytest.raises(ProcessingError):
        safe_endpoint(url)


def test_result_host_allowlist_is_exact(client, monkeypatch):
    from app.adapters.images import safe_endpoint
    from app.errors import ProcessingError
    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))])
    assert safe_endpoint("https://cdn.example/image", allowed_hosts=["cdn.example"]).hostname == "cdn.example"
    with pytest.raises(ProcessingError):
        safe_endpoint("https://cdn.example.attacker.test/image", allowed_hosts=["cdn.example"])


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
    from app.adapters.images import redraw
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
        config = config_for_test()
        config["provider"]["base_url"] = f"http://127.0.0.1:{server.server_port}/v1"
        config["provider"]["user_agent"] = "Mozilla/5.0"
        result = redraw(png, "image/png", "zh-Hans", config)
        assert result.image == png
        assert captured[0][0:2] == ("/v1/images/edits", "Mozilla/5.0")
        assert b'name="image"; filename="comic.png"' in captured[0][2]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
