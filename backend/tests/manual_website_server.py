"""Local website acceptance fixture. Synthetic OIDC/API only; no DB, R2 or paid calls.

Run from backend: python -m tests.manual_website_server (or python tests/manual_website_server.py).
"""
import base64
import hashlib
import json
from pathlib import Path
import secrets
import sys
import time
from types import SimpleNamespace
from urllib.parse import urlencode
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from app import website

ORIGIN = 'http://127.0.0.1:4322'
website.settings = lambda: SimpleNamespace(oidc_token_endpoint=ORIGIN + '/test-identity/token')
app = FastAPI()
codes = {}
tokens = set()
refreshes = set()
state = {'me_failure': 0, 'refresh_failure': 0, 'signed_out': False, 'checkout_count': 0, 'exchange_count': 0, 'cancel_at': None, 'subscribed': False}


@app.post('/test/reset')
async def reset(request: Request):
    state.update(await request.json())
    return {'ok': True}


@app.get('/test/state')
def test_state():
    return state


@app.get('/v1/auth/config')
def config():
    return {'mode':'oidc','dev_auth':False,'issuer':ORIGIN+'/test-identity','client_id':'website-fixture',
        'audience':ORIGIN+'/api','authorization_endpoint':ORIGIN+'/test-identity/auth',
        'token_endpoint':ORIGIN+'/test-identity/token','scopes':'openid profile offline_access'}


@app.get('/test-identity/auth')
def authorize(request: Request):
    params = dict(request.query_params)
    if (params.get('redirect_uri') != ORIGIN + '/auth/callback/' or params.get('code_challenge_method') != 'S256'
            or params.get('response_type') != 'code' or params.get('client_id') != 'website-fixture'
            or params.get('resource') != ORIGIN + '/api'):
        return JSONResponse({'error':'invalid_request'}, status_code=400)
    code = secrets.token_urlsafe(24)
    codes[code] = params
    return RedirectResponse(params['redirect_uri'] + '?' + urlencode({'code':code,'state':params['state']}), status_code=302)


def encode(value):
    return base64.urlsafe_b64encode(json.dumps(value,separators=(',',':')).encode()).decode().rstrip('=')


@app.post('/test-identity/token')
async def token(request: Request):
    form = await request.form()
    if form.get('client_id') != 'website-fixture' or form.get('resource') != ORIGIN + '/api':
        return JSONResponse({'error':'invalid_client'}, status_code=400)
    if form.get('grant_type') == 'refresh_token':
        if state['refresh_failure']:
            return JSONResponse({'error':'invalid_grant' if state['refresh_failure']==400 else 'server_error'}, status_code=state['refresh_failure'])
        if form.get('refresh_token') not in refreshes:
            return JSONResponse({'error':'invalid_grant'}, status_code=400)
        refreshes.discard(form.get('refresh_token'))
        params = {}
    else:
        params = codes.pop(form.get('code'), None)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(str(form.get('code_verifier','')).encode()).digest()).decode().rstrip('=')
        if not params or params['code_challenge'] != challenge or form.get('redirect_uri') != params['redirect_uri']:
            return JSONResponse({'error':'invalid_grant'}, status_code=400)
        state['exchange_count'] += 1
    access, refresh = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    tokens.add(access)
    refreshes.add(refresh)
    claims = {'iss':ORIGIN+'/test-identity','aud':'website-fixture','sub':'fixture-reader','name':'Demo Reader','iat':int(time.time()),'exp':int(time.time())+3600}
    if params.get('nonce'):
        claims['nonce'] = params['nonce']
    # Synthetic unsigned ID token is confined to this fake provider. Production API verifies real JWTs.
    return {'access_token':access,'refresh_token':refresh,'token_type':'Bearer','expires_in':3600,
        'id_token':encode({'alg':'none'})+'.'+encode(claims)+'.', 'scope':'openid profile offline_access'}


def authorized(request):
    return request.headers.get('Authorization','').removeprefix('Bearer ') in tokens


@app.get('/v1/me')
def me(request: Request):
    if not authorized(request) or state['me_failure']:
        return JSONResponse({'error':{'message':'账户服务暂时不可用，请重试。'}}, status_code=state['me_failure'] or 401)
    return {'user':{'id':'fixture-reader','name':'Demo Reader'},'entitlements':{'plan':'plus',
        'plus_expires_at':'2026-10-20T00:00:00Z','image_rate_limit':{'limit':100},
        'modes':{'classic':{'allowed':True,'unlimited':True,'quota':None},'redraw':{'allowed':True,'unlimited':False,'quota':{'available':287,'granted':300,'reserved':3}}}}}


@app.get('/v1/billing/status')
def billing(request: Request):
    if not authorized(request):
        return JSONResponse({},status_code=401)
    return {'enabled':True,'trial_eligible':True,'checkout_pending':False,'subscription':
        {'status':'active','next_billed_at':'2026-10-20T00:00:00Z','cancel_at':state['cancel_at']} if state['subscribed'] else None}


@app.post('/v1/billing/checkouts')
def checkout(request: Request):
    if not authorized(request):
        return JSONResponse({},status_code=401)
    state['checkout_count'] += 1
    return {'checkout_url':'https://checkout.stripe.com/c/pay/cs_test_fixture'}


@app.post('/v1/billing/portal')
def portal(request: Request):
    if not authorized(request):
        return JSONResponse({},status_code=401)
    return {'url':'https://billing.stripe.com/p/session/fixture'}


@app.post('/v1/billing/sync')
def sync_billing(request: Request):
    if not authorized(request):
        return JSONResponse({},status_code=401)
    return {'billing':billing(request),'entitlements':me(request)['entitlements']}


app.mount('/',website.WebsiteFiles(Path(__file__).resolve().parents[1]/'website'/'dist'))

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app,host='127.0.0.1',port=4322,access_log=False)
