"""Exercise the documented exporter against real routes, without external services."""
import json
import os
from pathlib import Path
import subprocess
import sys


def test_exporter_ignores_service_configuration_and_matches_checked_in_contract(tmp_path):
    root = Path(__file__).resolve().parents[2]
    working = tmp_path / "working"
    working.mkdir()
    marker = "isolated-export-secret-must-never-appear"
    for directory in (tmp_path, working):
        (directory / ".env").write_text(
            f"APP_ENV=invalid\nGA4_EXTENSION_API_SECRET={marker}\n", encoding="utf-8")
    target = tmp_path / "openapi.json"
    environment = {
        "SYSTEMROOT": os.environ.get("SYSTEMROOT", "C:\\Windows"),
        "TEMP": str(tmp_path),
        "TMP": str(tmp_path),
        "PYTHONDONTWRITEBYTECODE": "1",
        "APP_ENV": "production",
        "DEV_AUTH": "false",
        "DATABASE_URL": "postgresql+psycopg://unused:unused@database.invalid/unused",
        "GA4_DEBUG_MODE": "true",
        "GA4_EXTENSION_API_SECRET": marker,

        "PROVIDERS_JSON": "invalid-inherited-providers",
    }
    # An accidental dotenv read, startup migration, worker or external request is
    # a hard failure, even if the exporter would otherwise hide it in its output.
    guard = """
import os
import runpy
import sys
import threading

def audit(event, args):
    if event in {'socket.connect', 'socket.getaddrinfo', 'sqlite3.connect'}:
        raise RuntimeError('OpenAPI export attempted service access')
    if event == 'open' and isinstance(args[0], (str, bytes)):
        name = os.path.basename(os.fsdecode(args[0]))
        if name == '.env' or name.startswith('.env.'):
            raise RuntimeError('OpenAPI export attempted dotenv access')

def reject_thread(*args, **kwargs):
    raise RuntimeError('OpenAPI export attempted worker startup')

sys.addaudithook(audit)
threading.Thread.start = reject_thread
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name='__main__')
"""
    result = subprocess.run(
        [sys.executable, "-B", "-c", guard, str(root / "scripts/export_openapi.py"), "--output", str(target)],
        cwd=working, env=environment, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    exported_text = target.read_text(encoding="utf-8")
    assert marker not in result.stdout + result.stderr + exported_text
    expected = json.loads((root / "contracts/openapi.json").read_text(encoding="utf-8"))
    assert json.loads(exported_text) == expected
