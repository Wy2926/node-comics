"""Unchanged lease renewal creates no job events and never re-admits pages."""
from sqlalchemy import event
from conftest import login_plus
from test_cluster_submissions import cluster
from test_cluster_priority import accepted,prioritize,delta,lease


def test_reading_heartbeat_does_not_create_task_changes(cluster):
    from app.db import engine
    client,_=cluster
    auth=login_plus(client)
    ids=accepted(client,auth,10)
    response=prioritize(client,auth,ids[:3])
    assert response.status_code==200
    cursor=delta(client,auth)["cursor"]
    statements=[]
    def track(conn,cursor,sql,*args):statements.append(sql)
    event.listen(engine(),"before_cursor_execute",track)
    try:
        renewed=lease(client,auth,priority_epochs={"classic":response.json()["priority"]["classic"]["epoch"]})
    finally:event.remove(engine(),"before_cursor_execute",track)
    assert renewed.status_code==200,renewed.text
    assert len(statements)<90
    assert delta(client,auth,cursor)["items"]==[]
