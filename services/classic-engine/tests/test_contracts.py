import json
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import pytest
from manhua_engine.translation import Translator, parse_translation
from manhua_engine.backend import detector_input
from manhua_engine.cli import validate_outputs


def test_offline_never_calls_network(tmp_path,monkeypatch):
    def forbidden(*a,**kw): raise AssertionError('network accessed')
    monkeypatch.setattr('requests.post',forbidden)
    with pytest.raises(RuntimeError,match='cache miss'):
        Translator(tmp_path).translate(['hello'])


@pytest.mark.parametrize('raw',['<|1|>a','<|1|>a\n<|1|>b','<|1|>a\n<|3|>b','comment\n<|1|>a\n<|2|>b'])
def test_invalid_translation_rejected(raw):
    with pytest.raises(ValueError): parse_translation(raw,2)


def test_cache_is_content_addressed_and_single_flight(tmp_path,monkeypatch):
    calls=[]
    class Response:
        status_code=200
        def json(self): return {'choices':[{'finish_reason':'stop','message':{'content':'<|1|>你好'}}]}
    def post(*a,**kw): calls.append(kw);return Response()
    monkeypatch.setattr('requests.post',post);monkeypatch.setenv('OPENAI_API_KEY','test-key')
    t=Translator(tmp_path,mode='online')
    with ThreadPoolExecutor(4) as pool:
        assert list(pool.map(lambda _:t.translate(['hello']),range(4)))==[['你好']]*4
    assert len(calls)==1
    assert Translator(tmp_path).translate(['hello'])==['你好']
    with pytest.raises(RuntimeError,match='cache miss'): Translator(tmp_path,model='different').translate(['hello'])
    with pytest.raises(RuntimeError,match='cache miss'): Translator(tmp_path,target='Japanese').translate(['hello'])
    assert 'test-key' not in next(tmp_path.glob('*.json')).read_text(encoding='utf-8')


def test_normalization_and_padding():
    x,r=detector_input(np.full((1000,700,3),255,np.uint8))
    assert x.shape==(3,1024,768)
    assert r==1.024
    assert np.all(x[:,:,-1]==-1)
    assert np.all(x[:,:,0]==1)


def test_glossary_is_validated_and_isolates_translation_cache(tmp_path):
    original=Translator(tmp_path)
    terms=Translator(tmp_path,glossary={'明日香':'Asuka'})
    assert original.prompt==Translator(tmp_path,glossary={}).prompt
    assert original.prompt!=terms.prompt and 'Asuka' in terms.prompt
    with pytest.raises(ValueError,match='Glossary'):
        Translator(tmp_path,glossary={'name':''})


def test_reject_overwrites_and_collisions(tmp_path):
    with pytest.raises(ValueError,match='overwrite'):
        validate_outputs([tmp_path/'page.png'],tmp_path)
    with pytest.raises(ValueError,match='collide'):
        validate_outputs([tmp_path/'page.png',tmp_path/'page.webp'],tmp_path/'out')
    validate_outputs([tmp_path/'page.webp'],tmp_path/'out')
