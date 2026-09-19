"""Commit-time wakeups, never a durable queue. Every consumer rereads the DB."""
import asyncio
from contextlib import contextmanager
from threading import Event, RLock, Thread

from sqlalchemy import event, inspect, text
from sqlalchemy.orm import Session
from .db import engine


class Hub:
    def __init__(self, bind):
        self.bind = bind
        self.lock = RLock()
        self.waiters = {}
        self.stop = Event()
        self.ready = Event()
        self.thread = None

    def emit(self, topic=None):
        if topic == 'policy':
            topic = None
        with self.lock:
            for key, (loop, wake) in tuple(self.waiters.items()):
                if topic is None or key[0] == topic:
                    if not loop.is_closed():
                        loop.call_soon_threadsafe(wake.set)

    @contextmanager
    def subscribe(self, topic):
        from .errors import problem
        loop, wake = asyncio.get_running_loop(), asyncio.Event()
        key = (topic, id(wake))
        with self.lock:
            if len(self.waiters) >= 2048 or sum(k[0] == topic for k in self.waiters) >= (256 if topic == 'compute' else 4):
                from fastapi import HTTPException
                raise HTTPException(429, detail={'code': 'WAIT_BUSY', 'message': '等待连接已满，请稍后重试', 'scope': 'waiting_connection', 'retry_after_seconds': 2}, headers={'Retry-After': '2'})
            self.waiters[key] = (loop, wake)
        try:
            yield wake
        finally:
            with self.lock:
                self.waiters.pop(key, None)

    def start(self):
        if self.bind.dialect.name == 'postgresql' and self.thread is None:
            self.thread = Thread(target=self.listen, daemon=True, name='database-notifications')
            self.thread.start()

    def listen(self):
        import psycopg
        args, kwargs = self.bind.dialect.create_connect_args(self.bind.url)
        while not self.stop.is_set():
            try:
                with psycopg.connect(*args, **{**kwargs, 'autocommit': True, 'connect_timeout': 3}) as connection:
                    connection.execute('LISTEN comics_changes')
                    self.emit()  # Reconcile updates missed before LISTEN or during reconnect.
                    self.ready.set()
                    while not self.stop.is_set():
                        for notification in connection.notifies(timeout=1):
                            self.emit(notification.payload)
            except Exception:
                self.ready.clear()
                # No connection string, payload or DB exception in default logs.
                self.emit()
                self.stop.wait(1)

    def close(self):
        self.stop.set()
        self.emit()
        if self.thread:
            self.thread.join(timeout=5)


_hubs = {}
_lock = RLock()


def hub():
    bind = engine()
    with _lock:
        if bind not in _hubs:
            _hubs[bind] = Hub(bind)
        return _hubs[bind]


def publish(db, topic):
    # PostgreSQL only sends NOTIFY after commit; rollback sends nothing.
    if db.get_bind().dialect.name == 'postgresql':
        db.execute(text("SELECT pg_notify('comics_changes', :topic)"), {'topic': topic})
    db.info.setdefault('wake_topics', set()).add(topic)


@event.listens_for(Session, 'before_flush')
def policy_wakeups(db, flush_context, instances):
    """Wake on entitlement mutations; snapshots compute their durable revision."""
    from .models import User
    from .entitlement_models import QuotaPeriod
    topics = set()
    for row in db.new | db.dirty:
        if isinstance(row, User):
            state = inspect(row)
            if any(state.attrs[name].history.has_changes() for name in (
                    'membership_id', 'plus_started_at', 'plus_expires_at', 'plus_monthly_pages',
                    'billing_membership_id', 'billing_plus_started_at', 'billing_plus_expires_at') if name in state.attrs):
                if row.id:
                    topics.add('user:' + row.id)
        elif isinstance(row, QuotaPeriod):
            state = inspect(row)
            if row in db.new or any(state.attrs[name].history.has_changes()
                    for name in ('granted', 'starts_at', 'ends_at', 'grants_access')):
                topics.add('user:' + row.owner_id)
    for topic in topics:
        publish(db, topic)


@event.listens_for(Session, 'after_commit')
def committed(db):
    # Releasing a plan item's SAVEPOINT is not a committed public change.
    if db.in_nested_transaction():
        return
    topics = db.info.pop('wake_topics', ())
    with _lock:
        current = _hubs.get(db.get_bind())
    if current:
        for topic in topics:
            current.emit(topic)


@event.listens_for(Session, 'after_rollback')
def rolled_back(db):
    # A rejected plan item rolls back its SAVEPOINT, not successful siblings.
    # Extra wakeups are harmless: consumers always reconcile committed DB state.
    if not db.in_nested_transaction():
        db.info.pop('wake_topics', None)


def close_hub():
    with _lock:
        current = _hubs.pop(engine(), None)
    if current:
        current.close()


async def changed(wake, seconds):
    try:
        # Bounded reconciliation also covers process-local test DBs and missed signals.
        await asyncio.wait_for(wake.wait(), timeout=min(5, seconds))
    except TimeoutError:
        pass
