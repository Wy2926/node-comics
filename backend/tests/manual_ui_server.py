"""Isolated real API/worker UI fixture. No production env file, Redis or external AI calls.

Run: .venv/Scripts/python.exe tests/manual_ui_server.py
Connect the reader at http://localhost:5173 to http://127.0.0.1:18089.
Only the supplier adapter is synthetic; jobs, receipts, storage and accounting are real.
"""
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
directory = Path(tempfile.mkdtemp(prefix="nc-reader-ui-"))
os.environ.update(DATABASE_URL=f"sqlite:///{(directory/'test.sqlite').as_posix()}", STORAGE_PATH=str(directory/'objects'),
    DEV_AUTH="true", DEV_AUTH_SECRET="isolated-ui-signing-key-not-production", FREE_DAILY_PAGES="100", PLUS_MONTHLY_REDRAW_PAGES="300", FREE_CONCURRENCY="2", PLUS_CONCURRENCY="2", RESULT_STORAGE_BACKEND="local", R2_ENDPOINT_URL="", CLASSIC_ENABLED="true",
    CLASSIC_ENGINE_TOKEN="isolated-ui-engine", TEXT_API_KEY="isolated-ui-text", TEXT_BASE_URL="https://text.example/v1",
    OPENAI_API_KEY="isolated-ui-image", OPENAI_BASE_URL="https://provider.example/v1", OPENAI_MODEL="gpt-image-2", PROVIDERS_JSON="",
    CORS_ORIGINS="http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:5174")
from app.config import Settings
Settings.model_config["env_file"] = None
from app.main import app
from app.db import initialize, session_factory
from app.models import Job
from app.queue_models import QueueAdmission
from app.scheduler import admit_jobs
from app.adapters.images import TranslationOutput
from app.errors import ProcessingError
import app.workers as workers
from sqlalchemy import select
from PIL import Image, ImageDraw, ImageFont

controls = directory / "controls.json"
controls.write_text(json.dumps({"delay":6,"outcome":"success"}),encoding="utf-8")
def output(data):
    control=json.loads(controls.read_text(encoding="utf-8"))
    time.sleep(control.get("delay",6))
    if control.get("outcome")=="failed":raise ProcessingError("UI_FIXTURE_FAILED","交互测试：这一页处理失败，请重试。")
    if control.get("outcome")=="unknown":raise ProcessingError("UI_FIXTURE_UNKNOWN","交互测试：上游结果待核实。",unknown=True)
    if control.get("outcome")=="no_text":return TranslationOutput(None,no_text=True,usage={"fixture":True})
    image=Image.open(BytesIO(data)).convert("RGB")
    draw=ImageDraw.Draw(image);draw.rectangle((0,0,image.width,74),fill="#e8f2ff")
    draw.text((24,20),"INTERACTION TEST RESULT - NOT A TRANSLATION",fill="#185b9c",font=ImageFont.truetype("C:/Windows/Fonts/arial.ttf",max(12,int(image.width/35))))
    stream=BytesIO();image.save(stream,"PNG")
    return TranslationOutput(stream.getvalue(),usage={"fixture":True},quality_flags=["unrecognized_regions"] if control.get("outcome")=="partial" else [])
workers.redraw=lambda data,*args:output(data)
workers.run_classic=lambda job_id,attempt_id,data,*args:output(data)
initialize()
pool=ThreadPoolExecutor(max_workers=10)
running={}
def schedule():
    while True:
        try:
            admit_jobs()
            with session_factory()() as db:
                rows=db.execute(select(Job.id,QueueAdmission.token).join(QueueAdmission,Job.id==QueueAdmission.job_id).where(Job.status=="queued")).all()
            for job_id,token in rows:
                if job_id not in running or running[job_id].done():running[job_id]=pool.submit(workers.process_job,job_id,token)
        except Exception as error:print(f"UI fixture scheduler: {type(error).__name__}",flush=True)
        time.sleep(.5)
threading.Thread(target=schedule,daemon=True).start()
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
print(f'UI_FIXTURE_DIRECTORY={directory}',flush=True)
print('Synthetic supplier only; API http://127.0.0.1:18089',flush=True)
if __name__=='__main__':
    import uvicorn
    uvicorn.run(app,host='127.0.0.1',port=18089,log_level='warning',access_log=False)
