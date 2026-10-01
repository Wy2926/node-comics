"""Loopback-only browser fixture; no real identity, CAPTCHA, DB or model calls.

python tests/manual_website_translation_server.py
POST /test/reset controls failures; GET /test/state exposes synthetic counters.
The test-only widget is injected into HTML here, never into shipped code.
"""
import base64
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path

from fastapi import Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from PIL import Image, ImageDraw
from manual_website_server import app, authorized, me, state, website

app.router.routes.pop()  # Replace this fixture's final static mount only.
tasks = {}
state.update(guest=False, accepted=0, create_calls=0, input_calls=0, result_calls=0,
             fail_create_response_once=False, result_failure=False, last_input=None)


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
            'languages': [{'id':'zh-Hans','label':'简体中文'},{'id':'en','label':'English'}],
            'modes': [{'id':'classic','enabled':True,'languages':['zh-Hans','en']}, {'id':'redraw','enabled':True,'languages':['zh-Hans','en']}],
            'entitlements': me(request)['entitlements'] if authorized(request) else None}


def snapshot(key):
    return {name: value for name, value in tasks[key].items() if name in ('id','state','result')}


def can_read(request, key):
    return key in tasks and tasks[key]['owner'] == ('account' if '/v1/translations/' in request.url.path else 'guest')


@app.get('/v1/guest/translations/events')
@app.get('/v1/translations/events')
def events(request: Request, ids: str):
    if not can_read(request, ids):
        return error('TRANSLATION_NOT_FOUND',404)
    tasks[ids]['state'] = 'succeeded'
    payload = json.dumps({'items':[snapshot(ids)]})
    return Response('event: snapshot\ndata: '+payload+'\n\nevent: end\ndata: {}\n\n', media_type='text/event-stream')


@app.get('/v1/guest/translations/{key}')
@app.get('/v1/translations/{key}')
def get_task(key: str, request: Request):
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
    state['create_calls'] += 1
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
    state['input_calls']+=1
    state['last_input']={'width':width,'height':height,'bytes':len(data),'mime':request.headers.get('Content-Type')}
    return snapshot(key)


@app.get('/v1/guest/translations/{key}/result')
@app.get('/v1/translations/{key}/result')
def result(key: str, request: Request):
    if not can_read(request,key):
        return error('TRANSLATION_NOT_FOUND',404)
    state['result_calls']+=1
    if state['result_failure']:
        return error('NETWORK_ERROR',503)
    return Response(tasks[key]['artifact'],media_type='image/webp')


WIDGET = "window.turnstile={render:(element,options)=>{setTimeout(()=>options.callback('synthetic-proof'),25);return 'test-widget';},remove:()=>{}};"


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
