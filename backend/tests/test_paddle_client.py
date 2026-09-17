"""Exercise HTTP envelopes and pagination through the production client."""
from types import SimpleNamespace

import httpx
from pydantic import SecretStr
import pytest

from app import paddle_client


@pytest.fixture
def upstream(monkeypatch):
    monkeypatch.setattr(paddle_client, 'settings', lambda: SimpleNamespace(paddle_enabled=True,
        paddle_environment='sandbox', paddle_api_key=SecretStr('isolated-key')))
    state = {'responses':[], 'requests':[]}
    def handle(request):
        state['requests'].append(request)
        return state['responses'].pop(0)
    real_client = httpx.Client
    monkeypatch.setattr(paddle_client.httpx, 'Client',
        lambda **kwargs: real_client(transport=httpx.MockTransport(handle), **kwargs))
    return state


@pytest.mark.parametrize('payload', [
    {'data':[]}, {'data':{}, 'meta':{'pagination':{'has_more':False}}},
    {'data':[], 'meta':{'pagination':{'has_more':True}}},
    {'data':[], 'meta':{'pagination':{'has_more':'false'}}}, {'data':[], 'meta':'invalid'},
])
def test_invalid_pagination_fails_closed(upstream, payload):
    upstream['responses'] = [httpx.Response(200, json=payload)]
    with pytest.raises(paddle_client.PaddleError, match='PADDLE_INVALID_PAGINATION'):
        list(paddle_client.transaction_pages())


def test_pages_keep_filters_and_reject_a_stalled_cursor(upstream):
    payload = {'data':[{'id':'txn_'+'a'*26}], 'meta':{'pagination':{
        'has_more':True, 'next':'https://untrusted.example/steal-key'}}}
    upstream['responses'] = [httpx.Response(200, json=payload), httpx.Response(200, json=payload)]
    pages = paddle_client.transaction_pages(subscription_id='sub_test', **{'updated_at[GTE]':'2026-09-17T00:00:00Z'})
    assert next(pages) == payload['data']
    with pytest.raises(paddle_client.PaddleError, match='PADDLE_INVALID_PAGINATION'):
        next(pages)
    assert len(upstream['requests']) == 2
    for request in upstream['requests']:
        assert request.url.host == 'sandbox-api.paddle.com'
        assert request.url.params['subscription_id'] == 'sub_test'
        assert request.url.params['updated_at[GTE]'] == '2026-09-17T00:00:00Z'
        assert request.url.params['per_page'] == '30'
    assert upstream['requests'][-1].url.params['after'] == 'txn_'+'a'*26


@pytest.mark.parametrize('response', [httpx.Response(200, json=[]), httpx.Response(200, json={}),
                                    httpx.Response(200, json={'data':None}), httpx.Response(200, json={'data':[]}),
                                    httpx.Response(200, content=b'invalid'),
                                    httpx.Response(503, json={'error':{'code':'service_unavailable'}})])
def test_uncertain_post_response_cannot_be_treated_as_a_definite_rejection(upstream, response):
    upstream['responses'] = [response]
    with pytest.raises(paddle_client.PaddleError) as error:
        paddle_client.request('POST', '/transactions', {})
    assert error.value.uncertain
