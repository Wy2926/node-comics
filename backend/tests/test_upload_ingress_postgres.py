"""The same ingress invariants under actual PostgreSQL locks and independent sessions."""
import os
import pytest
from app import upload_models  # noqa: F401; register tables before the PG fixture creates its schema.
from test_classic_parallel_postgres import text_database
from test_upload_ingress import (
    ingress_case,
    test_shared_owner_global_and_same_upload_limits,
    test_parallel_replicas_cannot_overbook_global_or_owner_limit,
    test_expired_token_cannot_release_or_fail_replacement,
    test_waiting_body_releases_identity_connection_and_disconnect_releases_slot,
    test_cancelled_waiting_body_releases_slot_and_preserves_retry,
    test_cancel_during_r2_put_keeps_slot_and_heartbeat_until_thread_finishes,
    test_body_timeout_is_bounded_and_reservation_remains_retryable,
    test_lost_ingress_stops_waiting_for_client_body,
    test_accepted_replay_does_not_read_body_or_allocate_slot,
    test_cancelled_acquisition_releases_committed_slot,
    test_settings_changes_only_affect_new_upload_timeout_and_renewal,
)

pytestmark = pytest.mark.skipif(os.environ.get('RUN_POSTGRES_CONCURRENCY') != '1',
    reason='Requires the dedicated nodecomics_concurrency_test database')


@pytest.fixture
def storage_db(text_database):
    # The shared fixture creates and destroys a unique schema in the dedicated
    # test database; it refuses any production database name.
    yield


def test_two_http_replicas_share_limits_and_leave_single_connection_pool_free(ingress_case, tmp_path):
    """Hold real incomplete TCP uploads across two separate API processes."""
    from pathlib import Path
    import socket
    import subprocess
    import sys
    import time
    import httpx
    from app.auth import token_for
    from app.db import session_factory
    from app.models import User
    from test_upload_ingress import active_leases, configure_limits

    root = Path(__file__).resolve().parents[1]
    entry = root / 'tests/upload_ingress_http_server.py'
    case = ingress_case
    configure_limits(upload_user_concurrency=2, upload_global_concurrency=3,
                     upload_idle_timeout_seconds=15., upload_body_timeout_seconds=30.)
    alice, bob = case['owners']
    with session_factory()() as db:
        tokens = {owner: token_for(db.get(User, owner)) for owner in case['owners']}
    environment = {**os.environ, 'PYTHONPATH': str(root), 'PYTHONUNBUFFERED': '1',
                   'APP_ENV': 'test', 'RESULT_STORAGE_BACKEND': 'local', 'R2_ENDPOINT_URL': '',
                   'UPLOAD_USER_CONCURRENCY': '2', 'UPLOAD_GLOBAL_CONCURRENCY': '3',
                   'UPLOAD_IDLE_TIMEOUT_SECONDS': '15', 'UPLOAD_BODY_TIMEOUT_SECONDS': '30'}
    children, outputs, sockets = [], [], []
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0

    def until(predicate, timeout=10):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            result = predicate()
            if result:
                return result
            time.sleep(.03)
        raise AssertionError('Timed out waiting for isolated multi-replica HTTP condition')

    def hold(port, owner, index):
        connection = socket.create_connection(('127.0.0.1', port), timeout=3)
        sockets.append(connection)
        path = f"/v1/uploads/{case['uploads'][owner][index]}/content"
        headers = (f'PUT {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n'
                   f'Authorization: Bearer {tokens[owner]}\r\nContent-Type: image/png\r\n'
                   f"Content-Length: {len(case['data'])}\r\nConnection: close\r\n\r\n")
        connection.sendall(headers.encode() + case['data'][:1])
        return connection

    def rejected(port, owner, index):
        path = f"http://127.0.0.1:{port}/v1/uploads/{case['uploads'][owner][index]}/content"
        response = httpx.put(path, headers={'Authorization': 'Bearer ' + tokens[owner]},
                             content=case['data'], timeout=3, trust_env=False)
        assert response.status_code == 429
        assert response.json()['error']['code'] == 'UPLOAD_BUSY'

    try:
        ports = []
        for index in range(2):
            ready = tmp_path / f'ingress-api-{index}.port'
            output = (tmp_path / f'ingress-api-{index}.log').open('w', encoding='utf-8')
            outputs.append(output)
            child = subprocess.Popen([sys.executable, str(entry), str(ready)], cwd=tmp_path,
                                     env=environment, stdout=output, stderr=subprocess.STDOUT, creationflags=flags)
            children.append(child)
            def is_ready():
                assert child.poll() is None, 'Isolated API exited before HTTP readiness'
                return int(ready.read_text(encoding='ascii')) if ready.exists() else None
            ports.append(until(is_ready))
        first = hold(ports[0], alice, 0)
        until(lambda: len(active_leases()) == 1)
        hold(ports[1], alice, 1)
        until(lambda: len(active_leases()) == 2)
        rejected(ports[1], alice, 0)  # Same upload is serialized across replicas.
        rejected(ports[0], alice, 2)  # Same owner's separate upload is also bounded.
        hold(ports[1], bob, 0)
        until(lambda: len(active_leases()) == 3)
        rejected(ports[0], bob, 1)  # Other account cannot bypass the global cap.
        for port in ports:
            base = f'http://127.0.0.1:{port}'
            with httpx.Client(base_url=base, timeout=2, trust_env=False) as client:
                assert client.get('/__isolated_test/pool').json() == {'checkedout': 0}
                started = time.monotonic()
                response = client.get('/__isolated_test/identity', headers={'Authorization': 'Bearer ' + tokens[alice]})
                assert response.status_code == 200 and response.json()['id'] == alice
                assert time.monotonic() - started < 2
                assert client.get('/__isolated_test/pool').json() == {'checkedout': 0}
        first.shutdown(socket.SHUT_RDWR)
        first.close()
        sockets.remove(first)
        until(lambda: len(active_leases()) == 2)
        hold(ports[0], alice, 2)
        until(lambda: len(active_leases()) == 3)
        for connection in sockets:
            connection.sendall(case['data'][1:])
            response = connection.recv(4096)
            assert response.startswith(b'HTTP/1.1 200 OK'), response[:100]
        until(lambda: active_leases() == [])
    finally:
        for connection in sockets:
            connection.close()
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        for output in outputs:
            output.close()
