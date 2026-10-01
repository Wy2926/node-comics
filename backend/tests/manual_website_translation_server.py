"""Loopback-only browser fixture; no real identity, CAPTCHA, DB or model calls.

python tests/manual_website_translation_server.py
POST /__state controls failures; GET /__state exposes synthetic counters.
Use {"reset": true} to clear tasks and counters before a scenario. Delays are
milliseconds, capped at 30 seconds. The older /test/reset and /test/state work.
The test-only widget is injected into HTML here, never into shipped code.
"""
import base64
import asyncio
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path

from fastapi import Request
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from PIL import Image, ImageDraw
from manual_website_server import app, authorized, me, state, website
from app.languages import LANGUAGES, REDRAW_LANGUAGES

app.router.routes.pop()  # Replace this fixture's final static mount only.
tasks = {}
DEFAULTS = dict(guest=False, accepted=0, create_calls=0, input_calls=0, get_calls=0,
               result_calls=0, events_calls=0, fail_create_response_once=False,
               events_truncate_once=False, events_reconnect_once=False,
               events_delay_ms=250, result_delay_ms=0, widget_delay_ms=25,
               result_failure=False, result_failure_once=False, last_input=None)
state.update(DEFAULTS, requests={})


@app.post('/__state')
async def configure_fixture(request: Request):
    controls = await request.json()
    if not isinstance(controls, dict):
        return error('INVALID_FIXTURE_CONTROL', 400)
    for key, value in controls.items():
        if key not in state and key != 'reset':
            return error('INVALID_FIXTURE_CONTROL', 400)
        if key.endswith('_delay_ms') and (type(value) is not int or not 0 <= value <= 30000):
            return error('INVALID_FIXTURE_CONTROL', 400)
    if controls.pop('reset', False):
        tasks.clear()
        state.update(DEFAULTS, requests={})
    state.update(controls)
    return state


@app.get('/__state')
def fixture_state():
    return state


def count_request(key, operation):
    state[operation + '_calls'] += 1
    counts = state['requests'].setdefault(key, dict(create=0, input=0, get=0, result=0, events=0))
    counts[operation] += 1


def error(code, status=403):
    return JSONResponse({'error': {'code': code}}, status_code=status)


@app.get('/v1/guest/session')
def guest_session():
    return {'enabled': True, 'site_key': 'synthetic-widget-only', 'user_id': 'fixture-guest' if state['guest'] else None,
            'daily_limit': 5, 'remaining': max(0, 5-state['accepted']), 'resets_at': '2099-01-01T00:00:00Z'}


@app.post('/v1/guest/session')
async def start_session(request: Request):
    if (await request.json()).get('token') != 'synthetic-proof':
        return error('VERIFICATION_FAILED')
    state['guest'] = True
    return guest_session()


@app.get('/v1/capabilities')
def capabilities(request: Request):
    return {'result_protocol': 'overlay-v1', 'limits': {'max_bytes': 134217728, 'max_pixels': 32000000, 'max_dimension': 16000},
            'languages': [{'id':key,'label':label} for key,label in LANGUAGES.items()],
            'modes': [{'id':'classic','enabled':True,'languages':list(LANGUAGES)}, {'id':'redraw','enabled':True,'languages':REDRAW_LANGUAGES}],
            'entitlements': me(request)['entitlements'] if authorized(request) else None}


def snapshot(key):
    entry = tasks[key]
    return {'id': key, 'state': entry['state'],
            'result': entry.get('result') if entry['state'] == 'succeeded' else None}


def can_read(request, key):
    return key in tasks and tasks[key]['owner'] == ('account' if '/v1/translations/' in request.url.path else 'guest')


@app.get('/v1/guest/translations/events')
@app.get('/v1/translations/events')
async def events(request: Request, ids: str):
    count_request(ids, 'events')
    if not can_read(request, ids):
        return error('TRANSLATION_NOT_FOUND',404)
    truncate, reconnect = state['events_truncate_once'], state['events_reconnect_once']
    if truncate:
        state['events_truncate_once'] = False
    elif reconnect:
        state['events_reconnect_once'] = False
    delay = state['events_delay_ms'] / 1000

    def frame():
        return 'event: snapshot\ndata: ' + json.dumps({'items': [snapshot(ids)], 'missing_ids': []}) + '\n\n'

    async def frames():
        yield frame()
        if truncate or reconnect:
            await asyncio.sleep(delay)
            if truncate:
                yield 'event: snapshot\ndata: {"items":['  # EOF halfway through a frame.
            else:
                yield 'event: end\ndata: {"reason":"reconnect"}\n\n'
            return
        if tasks[ids]['state'] == 'needs_input':
            yield 'event: end\ndata: {"reason":"reconnect"}\n\n'
            return
        if tasks[ids]['state'] != 'succeeded':
            tasks[ids]['state'] = 'running'
            yield frame()
            await asyncio.sleep(delay)
            tasks[ids]['state'] = 'succeeded'
            yield frame()
        yield 'event: end\ndata: {"reason":"complete"}\n\n'

    return StreamingResponse(frames(), media_type='text/event-stream', headers={
        'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'})


@app.get('/v1/guest/translations/{key}')
@app.get('/v1/translations/{key}')
def get_task(key: str, request: Request):
    count_request(key, 'get')
    return snapshot(key) if can_read(request,key) else error('TRANSLATION_NOT_FOUND',404)


@app.put('/v1/guest/translations/{key}')
@app.put('/v1/translations/{key}')
async def create_task(key: str, request: Request):
    body = await request.json()
    guest = '/v1/guest/' in request.url.path
    if guest and (not state['guest'] or request.headers.get('X-Turnstile-Token') != 'synthetic-proof'):
        return error('VERIFICATION_FAILED')
    if not guest and not authorized(request):
        return error('AUTH_REQUIRED',401)
    count_request(key, 'create')
    if key not in tasks:
        if guest and state['accepted'] >= 5:
            return error('GUEST_DAILY_LIMIT',429)
        if guest:
            state['accepted'] += 1
        tasks[key] = {'id':key,'state':'needs_input','owner':'guest' if guest else 'account','body':body}
    if state['fail_create_response_once']:
        state['fail_create_response_once'] = False
        return error('NETWORK_ERROR',503)  # Admission happened; response was lost.
    return JSONResponse(snapshot(key),status_code=202)


@app.put('/v1/guest/translations/{key}/input')
@app.put('/v1/translations/{key}/input')
async def upload(key: str, request: Request):
    if not can_read(request,key):
        return error('TRANSLATION_NOT_FOUND',404)
    data = await request.body()
    entry = tasks[key]
    descriptor = entry['body']['image']
    assert descriptor['sha256'] == sha256(data).hexdigest()
    assert descriptor['byte_size'] == len(data)
    with Image.open(BytesIO(data)) as image:
        width,height = image.size
    patch = Image.new('RGBA',(500,150),'white')
    ImageDraw.Draw(patch).text((30,60),'TRANSLATED TEST IMAGE',fill='black',font_size=30)
    buffer=BytesIO();patch.save(buffer,format='WEBP',lossless=True);artifact=buffer.getvalue()
    entry['artifact']=artifact
    entry['result']={'kind':'translated','representation':'overlay-v1','input_sha256':descriptor['sha256'],
                     'normalization_version':1,'width':width,'height':height,'bbox':{'x':50,'y':50,'width':500,'height':150},
                     'composite':'source-atop','artifact':{'sha256':sha256(artifact).hexdigest(),'byte_size':len(artifact),
                                                        'mime':'image/webp','path':str(request.url.path).removesuffix('/input')+'/result'}}
    entry['state']='queued'
    count_request(key, 'input')
    state['last_input']={'width':width,'height':height,'bytes':len(data),'mime':request.headers.get('Content-Type')}
    return snapshot(key)


@app.get('/v1/guest/translations/{key}/result')
@app.get('/v1/translations/{key}/result')
async def result(key: str, request: Request):
    count_request(key, 'result')
    if not can_read(request,key):
        return error('TRANSLATION_NOT_FOUND',404)
    await asyncio.sleep(state['result_delay_ms'] / 1000)
    if state['result_failure'] or state['result_failure_once']:
        state['result_failure_once'] = False
        return error('NETWORK_ERROR',503)
    return Response(tasks[key]['artifact'],media_type='image/webp')


WIDGET = """window.turnstile=(()=>{
  let sequence=0;const widgets=new Map();
  return {render:(element,options)=>{
    const id='test-widget-'+(++sequence),box=document.createElement('div');
    const compact=options.size==='compact';
    box.style.cssText='box-sizing:border-box;display:flex;align-items:center;justify-content:center;'+
      'background:#fafafa;border:1px solid #d6d6d6;color:#222;font:14px sans-serif;'+
      'width:'+(compact?150:300)+'px;height:'+(compact?140:65)+'px';
    box.textContent='模拟验证';element.replaceChildren(box);
    const entry={box,timer:undefined};widgets.set(id,entry);
    fetch('/__state',{cache:'no-store'}).then(response=>response.json()).then(config=>{
      if(!widgets.has(id))return;
      entry.timer=setTimeout(()=>{
        if(!widgets.has(id))return;
        box.textContent='✓ 模拟验证';options.callback('synthetic-proof');
      },config.widget_delay_ms);
    }).catch(()=>{if(widgets.has(id))options['error-callback']?.();});
    return id;
  },remove:id=>{const entry=widgets.get(id);if(entry){clearTimeout(entry.timer);entry.box.remove();widgets.delete(id);}}};
})();"""


class FixtureWebsite(website.WebsiteFiles):
    async def get_response(self, path, scope):
        response=await super().get_response(path,scope)
        if 'text/html' in response.headers.get('content-type','') and 'translate' in path.split('/'):
            html=Path(response.path).read_text(encoding='utf-8').replace('<head>','<head><script>'+WIDGET+'</script>')
            digest=base64.b64encode(sha256(WIDGET.encode()).digest()).decode()
            headers=dict(response.headers)
            headers.pop('content-length',None);headers.pop('etag',None)
            headers['content-security-policy']=headers['content-security-policy'].replace("script-src 'self'",f"script-src 'self' 'sha256-{digest}'")
            return HTMLResponse(html,headers=headers)
        return response


app.mount('/',FixtureWebsite(Path(__file__).resolve().parents[1]/'website'/'dist'))

if __name__ == '__main__':
    import uvicorn
    output=Path(__file__).resolve().parents[2]/'artifacts'/'website-translation'
    output.mkdir(parents=True,exist_ok=True)
    image=Image.new('RGB',(2400,3600),'#edf3fa')
    draw=ImageDraw.Draw(image)
    for index in range(8):
        y=80+index*440
        draw.rounded_rectangle((80,y,2320,y+360),radius=30,fill='#b8cfe8' if index%2 else '#ffffff',outline='#245788',width=10)
        draw.text((180,y+140),'Synthetic comic panel '+str(index+1),fill='#12283f',font_size=60)
    image.save(output/'sample.png')
    uvicorn.run(app,host='127.0.0.1',port=4322,access_log=False)
