"""Page-pack catalog validation without platform calls or seeded sale prices."""
import pytest
from pydantic import ValidationError
from test_stripe_billing import billing
from test_billing_catalog import administrator


def pack(**changes):
    return dict(id='pages', revision_id='pages-v1', name='Page pack',
        monthly_classic_pages=0, trial_days=0, trial_classic_pages=0,
        service_plan_id='plus', quota_pages=500, quota_validity_days=None,
        hourly_image_limit=1200) | changes


@pytest.mark.parametrize('changes', [
    {'quota_pages': True}, {'quota_pages': -1}, {'quota_pages': 1_000_001},
    {'quota_validity_days': 0}, {'quota_validity_days': 36501},
    {'service_plan_id': None}, {'monthly_classic_pages': 1},
    {'trial_days': 7}, {'trial_classic_pages': 1},
    {'monthly_classic_pages': None}, {'trial_classic_pages': None},
])
def test_pack_cannot_mix_subscription_trial_or_invalid_quantity(changes):
    from app.billing_catalog import ProductRequest
    with pytest.raises(ValidationError):
        ProductRequest(**pack(**changes))


@pytest.mark.parametrize('days', [None, 30])
def test_pack_is_immutable_and_uses_only_once_prices(billing, days):
    client, auth = billing['client'], administrator(billing)
    payload = pack(quota_validity_days=days)
    response = client.post('/v1/admin/billing/products', headers=auth, json=payload)
    assert response.status_code == 200, response.text
    assert client.post('/v1/admin/billing/products', headers=auth, json=payload).status_code == 200
    assert client.post('/v1/admin/billing/products', headers=auth,
        json=payload | {'quota_pages': 501}).status_code == 409
    price = dict(id='pages-price', plan_revision_id='pages-v1', currency='usd',
        unit_amount=100, interval='once', environment='test')
    for interval in ('month', 'year'):
        assert client.post('/v1/admin/billing/prices', headers=auth,
            json=price | {'interval': interval}).status_code == 422
    response = client.post('/v1/admin/billing/prices', headers=auth, json=price)
    assert response.status_code == 200, response.text
    assert client.post('/v1/admin/billing/prices', headers=auth, json=price).status_code == 200
    assert client.post('/v1/admin/billing/prices', headers=auth,
        json=price | {'unit_amount': 200}).status_code == 409
    catalog = client.get('/v1/admin/billing/catalog', headers=auth).json()
    revision = next(p for p in catalog['products'] if p['id'] == 'pages')['revisions'][0]
    assert (revision['quota_pages'], revision['quota_validity_days'], revision['service_plan_id']) == (500, days, 'plus')
    assert not client.get('/v1/billing/catalog').json()['quota_offers']


def test_pack_service_tier_must_reference_existing_subscription_product(billing):
    client, auth = billing['client'], administrator(billing)
    assert client.post('/v1/admin/billing/products', headers=auth,
        json=pack(service_plan_id='missing')).status_code == 422
    assert client.post('/v1/admin/billing/products', headers=auth, json=pack()).status_code == 200
    assert client.post('/v1/admin/billing/products', headers=auth,
        json=pack(id='other', revision_id='other-v1', service_plan_id='pages')).status_code == 422


def test_subscription_revision_cannot_receive_one_off_price(billing):
    client, auth = billing['client'], administrator(billing)
    response = client.post('/v1/admin/billing/prices', headers=auth, json={
        'id': 'incorrect-once', 'plan_revision_id': 'plus-v1', 'currency': 'usd',
        'unit_amount': 100, 'interval': 'once', 'environment': 'test'})
    assert response.status_code == 422, response.text
