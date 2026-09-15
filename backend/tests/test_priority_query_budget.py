"""A 500-page queue must not create 500 updates for every reading heartbeat."""
from sqlalchemy import event
from conftest import login_plus
from test_cluster_submissions import cluster
from test_cluster_priority import accepted, prioritize, delta


def test_reading_heartbeat_only_changes_realtime_window(cluster):
    from app.db import engine
    client, _ = cluster
    auth = login_plus(client)
    ids = accepted(client, auth, 500)
    response = prioritize(client, auth, ids[:10], ordered_job_ids=ids)
    assert response.status_code == 200
    cursor = "0"
    while True:
        changes = delta(client, auth, cursor)
        cursor = changes["cursor"]
        if not changes["has_more"]:
            break
    statements = []
    def track(conn, query_cursor, sql, *args):
        statements.append(sql)
    event.listen(engine(), "before_cursor_execute", track)
    try:
        response = prioritize(client, auth, ids[:10], ordered_job_ids=ids, sequence=2,
                              expected_version=response.json()["version"])
    finally:
        event.remove(engine(), "before_cursor_execute", track)
    assert response.status_code == 200
    assert len(statements) < 90
    changes = delta(client, auth, cursor)
    assert {j["id"] for j in changes["items"]} == set(ids[:10])
    assert not changes["has_more"]
