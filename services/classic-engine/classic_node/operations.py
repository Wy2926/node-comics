"""Bounded, credential-free operational state for an OS-supervised node."""
from datetime import datetime, timezone
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import threading
import time
import traceback

LOG = logging.getLogger('classic-node')


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def configure_logging(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(directory / 'node.log', maxBytes=10 * 1024 * 1024,
                                  backupCount=5, encoding='utf-8')
    formatter = logging.Formatter('%(asctime)sZ %(levelname)s %(message)s', '%Y-%m-%dT%H:%M:%S')
    formatter.converter = time.gmtime
    handler.setFormatter(formatter)
    LOG.setLevel(logging.INFO)
    LOG.propagate = False
    LOG.addHandler(handler)
    return handler


def report_fatal(error):
    # Messages, source lines and local variables can contain image text or URLs.
    frames = traceback.extract_tb(error.__traceback__)
    locations = ','.join(f'{Path(f.filename).name}:{f.lineno}:{f.name}' for f in frames[-8:])
    LOG.error('event=fatal type=%s stack=%s', type(error).__name__, locations)


class NetworkLog:
    def __init__(self):
        self.failures = {}
        self.lock = threading.Lock()

    def failed(self, action, error):
        signature = (error.code, getattr(error, 'status', 0), getattr(error, 'cause', ''))
        with self.lock:
            previous, logged, count = self.failures.get(action, (None, 0, 0))
            count += 1
            if signature != previous or time.monotonic() - logged >= 60:
                LOG.warning('event=connection_failed action=%s code=%s http_status=%s cause=%s attempts=%s',
                            action, *signature, count)
                logged = time.monotonic()
            self.failures[action] = (signature, logged, count)

    def succeeded(self, action):
        with self.lock:
            previous = self.failures.pop(action, None)
        if previous:
            LOG.info('event=connection_recovered action=%s failed_attempts=%s', action, previous[2])


class Operations:
    """Network outages retry in-process; only local stalls cause watchdog exit."""
    def __init__(self, directory, stop, *, startup_seconds=600, stall_seconds=120,
                 shutdown_seconds=60, hard_exit=os._exit):
        self.directory = Path(directory)
        self.stop = stop
        self.hard_exit = hard_exit
        self.startup_seconds = startup_seconds
        self.stall_seconds = stall_seconds
        self.shutdown_seconds = shutdown_seconds
        self.started_at = utc_now()
        self.last_pulse = time.monotonic()
        self.phase = 'starting'
        self.stopping_at = None
        self.agent = None
        self.finished = threading.Event()
        self.thread = threading.Thread(target=self.run, name='node-health', daemon=True)

    def pulse(self):
        self.last_pulse = time.monotonic()

    def attach(self, agent):
        self.agent = agent
        self.phase = 'running'
        self.pulse()

    def stopping(self):
        if self.stopping_at is None:
            self.stopping_at = time.monotonic()
            self.phase = 'stopping'
            LOG.info('event=stopping grace_seconds=%s', self.shutdown_seconds)
        self.stop.set()

    def snapshot(self):
        agent = self.agent
        last = agent.heartbeat_at if agent else None
        age = time.monotonic() - agent.heartbeat_monotonic if agent and last else None
        return {'pid': os.getpid(), 'started_at': self.started_at, 'updated_at': utc_now(),
                'phase': self.phase, 'loop_age_seconds': round(time.monotonic() - self.last_pulse, 1),
                'heartbeat_at': last, 'heartbeat_age_seconds': round(age, 1) if age is not None else None,
                'connected': bool(age is not None and age < 60 and self.phase == 'running'),
                'active_leases': len(agent.pages) if agent else 0,
                'config_version': agent.config['version'] if agent and agent.config else None}

    def write(self):
        temporary = self.directory / 'status.json.tmp'
        temporary.write_text(json.dumps(self.snapshot(), allow_nan=False), encoding='utf-8')
        for attempt in range(5):
            try:
                temporary.replace(self.directory / 'status.json')
                return
            except PermissionError:
                # Windows readers/antivirus can briefly hold a non-delete-shared
                # handle; this does not mean the node or disk has failed.
                if attempt == 4:
                    raise
                time.sleep(.05)

    def check(self):
        if (self.directory / 'stop').exists() or self.stop.is_set():
            self.stopping()
        now = time.monotonic()
        if self.stopping_at is not None:
            expired = now - self.stopping_at >= self.shutdown_seconds
        else:
            expired = now - self.last_pulse >= (self.startup_seconds if self.phase == 'starting' else self.stall_seconds)
        if expired:
            LOG.error('event=watchdog_exit phase=%s', self.phase)
            self.hard_exit(1)

    def run(self):
        write_failures = 0
        while not self.finished.wait(1):
            try:
                self.check()
                self.write()
                write_failures = 0
            except OSError as error:
                write_failures += 1
                if write_failures == 1:
                    LOG.warning('event=status_write_failed type=%s', type(error).__name__)
                if write_failures >= 10:
                    report_fatal(error)
                    self.hard_exit(1)
            except Exception as error:
                report_fatal(error)
                self.hard_exit(1)

    def start(self):
        self.write()
        self.thread.start()

    def close(self, failed=False):
        self.finished.set()
        self.thread.join(timeout=2)
        self.phase = 'failed' if failed else 'stopped'
        self.write()
