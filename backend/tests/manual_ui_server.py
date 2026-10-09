"""Isolated API/worker UI fixture. No production env file or external AI calls.

Run: .venv/Scripts/python.exe tests/manual_ui_server.py
Connect the reader at http://localhost:5173 to http://127.0.0.1:18089.
Requires Redis 8 (TEST_REDIS_URL or localhost:6379), with a fresh private namespace.
The page engine is synthetic; claims, storage, cancellation and accounting are real.
"""
from io import BytesIO
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import zipfile
from types import SimpleNamespace

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
fixture_root = Path(os.environ.get("READER_FIXTURE_ROOT", root / ".tmp"))
fixture_root.mkdir(parents=True, exist_ok=True)
directory = Path(tempfile.mkdtemp(prefix="nc-reader-ui-", dir=fixture_root))
port = int(os.environ.get("READER_FIXTURE_PORT", "18089"))
os.environ.update(DATABASE_URL=f"sqlite:///{(directory/'test.sqlite').as_posix()}", STORAGE_PATH=str(directory/'objects'),
    REDIS_URL=os.environ.get('TEST_REDIS_URL', 'redis://127.0.0.1:6379/0'), REDIS_NAMESPACE=directory.name,
    APP_ENV="test", DEV_AUTH="true", DEV_AUTH_SECRET="isolated-ui-signing-key-not-production", FREE_DAILY_PAGES="30", CLASSIC_ENABLED="true",
    CORS_ORIGINS="http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:5174,http://127.0.0.1:5176")
from app.config import Settings
Settings.model_config["env_file"] = None
from app.main import app
from app.db import session_factory
from app.migrate import migrate
from translation_fixtures import configure_text_provider

from app.errors import ProcessingError
import app.workers as workers
from PIL import Image, ImageDraw, ImageFont

controls = directory / "controls.json"
controls.write_text(json.dumps({"delay":6,"outcome":"success"}),encoding="utf-8")
def output(data):
    control=json.loads(controls.read_text(encoding="utf-8"))
    time.sleep(control.get("delay",6))
    if control.get("outcome")=="failed":raise ProcessingError("UI_FIXTURE_FAILED","交互测试：这一页处理失败，请重试。")
    if control.get("outcome")=="unknown":raise ProcessingError("UI_FIXTURE_UNKNOWN","交互测试：上游结果待核实。",unknown=True)
    if control.get("outcome")=="no_text":return None
    image=Image.open(BytesIO(data)).convert("RGB")
    draw=ImageDraw.Draw(image);draw.rectangle((0,0,image.width,74),fill="#e8f2ff")
    draw.text((24,20),"INTERACTION TEST RESULT - NOT A TRANSLATION",fill="#185b9c",font=ImageFont.truetype("C:/Windows/Fonts/arial.ttf",max(12,int(image.width/35))))
    stream=BytesIO();image.save(stream,"PNG")
    return stream.getvalue()
sys.path.insert(0, str(root.parent / 'scripts' / 'tests'))
from classic_fixture_worker import SyntheticPageWorker
# The fixture embeds the control loop in a background thread; uvicorn owns the
# process signals. Production workers still install their normal drain handlers.
workers.signal = SimpleNamespace(SIGTERM=workers.signal.SIGTERM, SIGINT=workers.signal.SIGINT, signal=lambda *_: None)
migrate()
with session_factory()() as db:
    configure_text_provider(db)
threading.Thread(target=workers.main,daemon=True).start()
page_worker = SyntheticPageWorker(output)
threading.Thread(target=page_worker.run, daemon=True).start()
# Small numbered synthetic pages support directory-window and page-failure checks.
samples=directory/'pages';samples.mkdir()
for i in range(1,25):
    image=Image.new('RGB',(800,1200),'#ffffff');draw=ImageDraw.Draw(image)
    draw.rectangle((25,25,775,1175),outline='#34506b',width=3)
    draw.text((65,65),f'READER TEST / PAGE {i:02}',font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',36),fill='#24394e')
    for n in range(3):
        top=150+n*320;draw.rectangle((65,top,735,top+265),fill=['#e7edf9','#f8eee1','#e9f3f0'][n],outline='#52677e',width=2)
        draw.ellipse((180,top+40,310,top+170),fill='#93aec5');draw.ellipse((490,top+50,620,top+180),fill='#c5b29f')
        draw.text((90,top+220),f'Synthetic panel {n+1}',font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',22),fill='#24394e')
    image.save(samples/f'page-{i:02}.png')
with zipfile.ZipFile(directory/'cluster-eight.cbz', 'w') as archive:
    for i in range(1,9):
        archive.write(samples/f'page-{i:02}.png', f'page-{i:02}.png')
print(f'UI_FIXTURE_DIRECTORY={directory}',flush=True)
print(f'Synthetic page engine only; API http://127.0.0.1:{port}',flush=True)
if __name__=='__main__':
    import uvicorn
    uvicorn.run(app,host='127.0.0.1',port=port,log_level='warning',access_log=False)
