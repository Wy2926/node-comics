"""Run a disposable admin UI fixture on 18090. No real users, images or suppliers."""
import os
import asyncio
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
directory = Path(tempfile.mkdtemp(prefix="nc-admin-ui-"))
os.environ.update(DATABASE_URL=f"sqlite:///{(directory / 'test.sqlite').as_posix()}",
    STORAGE_PATH=str(directory / "objects"), DEV_AUTH="true", DEV_AUTH_SECRET="admin-ui-isolated-signing-secret-0001",
    DEV_ADMIN_USERNAME="admin", RESULT_STORAGE_BACKEND="local", R2_ENDPOINT_URL="", CLASSIC_ENABLED="false",
    OPENAI_API_KEY="", PROVIDERS_JSON="")
from app.config import Settings
Settings.model_config["env_file"] = None
from app.main import app
from app.db import initialize, session_factory
from admin_fixture import seed
from fastapi.responses import JSONResponse

controls = directory / "controls.json"
controls.write_text('{"delay":0,"fail":false}', encoding="utf-8")


@app.middleware("http")
async def fixture_faults(request, call_next):
    if request.url.path.startswith("/v1/admin/monitor/"):
        state = json.loads(controls.read_text(encoding="utf-8"))
        if state.get("delay"):
            await asyncio.sleep(min(float(state["delay"]), 10))
        if state.get("fail"):
            return JSONResponse({"error": {"code": "FIXTURE_UNAVAILABLE", "message": "隔离测试：监控接口暂时不可用"}}, status_code=503)
    return await call_next(request)

initialize()
with session_factory()() as db:
    seed(db)
print("Synthetic admin fixture: http://127.0.0.1:18090/admin/ (username: admin)", flush=True)
print(f"ADMIN_FIXTURE_CONTROLS={controls}", flush=True)
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=18090, access_log=False, log_level="warning")
