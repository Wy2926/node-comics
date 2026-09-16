"""Signals must drain accepted work rather than leave a container stuck as PID 1."""
import os
from pathlib import Path
import subprocess
import sys
import textwrap


def test_control_worker_sigterm_drains_an_active_stage(tmp_path):
    # A child process gives this test its own signal handlers. All database and
    # stage boundaries are isolated; no provider, production DB, or R2 is used.
    program = textwrap.dedent('''
        import signal
        from threading import Event, Timer
        from types import SimpleNamespace
        from app import workers, control_pools

        started, release, finished = Event(), Event(), Event()
        state = {"issued": False, "signalled": False}

        class Session:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def commit(self): pass

        def claim(*args, **kwargs):
            if not state["issued"]:
                state["issued"] = True
                return SimpleNamespace(id="isolated-stage")
            if not state["signalled"]:
                assert started.wait(2)
                state["signalled"] = True
                signal.raise_signal(signal.SIGTERM)
                Timer(.2, release.set).start()
            else:
                raise AssertionError("Claimed new work after shutdown")

        def run(stage_id):
            assert stage_id == "isolated-stage"
            started.set()
            assert release.wait(3)
            finished.set()

        workers.initialize = lambda: None
        workers.session_factory = lambda: Session
        workers.claim_stage = claim
        workers.run_control_stage = run
        workers.report_progress = lambda *args: None
        workers.report_failure = lambda *args: None
        control_pools.POOL_LIMITS = {"text": 1, "redraw": 1}
        control_pools.initialize_pools = lambda db: None
        control_pools.report_pools = lambda db: None
        workers.main()
        assert state["signalled"] and finished.is_set()
        print("active stage drained")
    ''')
    env = {k: v for k, v in os.environ.items() if k.upper() in {
        'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LANG'}}
    env.update(PYTHONPATH=str(Path(__file__).resolve().parents[1]),
               APP_ENV='test', DEV_AUTH='true', DEV_AUTH_SECRET='isolated-signal-test-' * 3,
               RESULT_STORAGE_BACKEND='local', R2_ENDPOINT_URL='')
    result = subprocess.run([sys.executable, '-c', program], cwd=tmp_path, env=env,
                            capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert 'active stage drained' in result.stdout
