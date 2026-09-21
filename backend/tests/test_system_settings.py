"""Shared settings authorization, validation, snapshots and atomic version updates."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from conftest import login
from app.auth import token_for
from app.config import settings
from app.db import engine, session_factory
from app.models import User, uid
from app.system_settings import (RequestLimits, SystemSettings, SystemSettingsUpdate, get_request_limits,
    initialize_system_settings, put_system_settings, router, settings_json)
from test_classic import text_database

DEFAULTS = {
    "free_daily_pages": 30, "plus_monthly_redraw_pages": 300,
    "free_scheduler_weight": 1.0, "plus_scheduler_weight": 2.0,
    "free_images_per_minute": 10, "plus_images_per_minute": 100,
    "upload_user_concurrency": 10, "upload_global_concurrency": 16,
    "upload_idle_timeout_seconds": 15, "upload_body_timeout_seconds": 120,
    "upload_ingress_lease_seconds": 45, "feedback_requests_per_minute": 30,
    "feedback_request_burst": 10, "feedback_receipts_per_day": 100,
}
PATH = "/v1/admin/system-settings"


def test_main_application_exposes_system_settings(client):
    auth = login(client, "admin")
    original = client.get(PATH, headers=auth)
    assert original.status_code == 200, original.text
    values = {**original.json()["values"], "feedback_receipts_per_day": 73}
    body = {"expected_version": original.json()["version"], "values": values}
    changed = client.put(PATH, headers=auth, json=body)
    assert changed.status_code == 200 and changed.json()["values"] == values
    conflict = client.put(PATH, headers=auth, json=body)
    assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "SYSTEM_SETTINGS_CONFLICT"


@pytest.fixture
def system_case(text_database):
    for name, value in DEFAULTS.items():
        setattr(settings(), name, value)
    with session_factory()() as db:
        operator = User(id=uid(), subject="settings-admin", name="Admin", role="admin")
        reader = User(id=uid(), subject="settings-reader", name="Reader", role="user")
        db.add_all([operator, reader])
        db.commit()
        auth = {"Authorization": "Bearer " + token_for(operator)}
        reader_auth = {"Authorization": "Bearer " + token_for(reader)}
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, auth=auth, reader_auth=reader_auth,
                              owner_id=operator.id, reader_id=reader.id)


def test_only_administrators_can_read_and_change_settings(system_case):
    case = system_case
    body = {"expected_version": 1, "values": DEFAULTS}
    for method, kwargs in (("get", {}), ("put", {"json": body})):
        assert getattr(case.client, method)(PATH, **kwargs).status_code == 401
        assert getattr(case.client, method)(PATH, headers=case.reader_auth, **kwargs).status_code == 403
    original = case.client.get(PATH, headers=case.auth).json()
    assert original["version"] == 1 and original["values"] == DEFAULTS
    assert original["updated_by"] is None and original["updated_at"].endswith("Z")
    values = {**DEFAULTS, "upload_user_concurrency": 12, "upload_global_concurrency": 24,
              "feedback_requests_per_minute": 40}
    response = case.client.put(PATH, headers=case.auth, json={"expected_version": 1, "values": values})
    assert response.status_code == 200, response.text
    assert response.json()["version"] == 2 and response.json()["values"] == values
    assert response.json()["updated_by"] == case.owner_id
    stale = case.client.put(PATH, headers=case.auth, json=body)
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "SYSTEM_SETTINGS_CONFLICT"
    assert stale.json()["detail"]["current_version"] == 2
    assert case.client.get(PATH, headers=case.auth).json() == response.json()


@pytest.mark.parametrize("change", [
    {"free_images_per_minute": 0}, {"plus_images_per_minute": 10001}, {"free_images_per_minute": True},
    {"upload_user_concurrency": 0}, {"upload_user_concurrency": 33},
    {"upload_global_concurrency": 129}, {"upload_user_concurrency": True},
    {"upload_idle_timeout_seconds": "15"}, {"upload_idle_timeout_seconds": 0},
    {"upload_body_timeout_seconds": 901}, {"upload_ingress_lease_seconds": 14},
    {"upload_ingress_lease_seconds": 301}, {"feedback_requests_per_minute": 1001},
    {"feedback_request_burst": 101}, {"feedback_receipts_per_day": 10001},
    {"unrecognized_field": 1},
])
def test_invalid_values_do_not_change_settings(system_case, change):
    case = system_case
    original = case.client.get(PATH, headers=case.auth).json()
    response = case.client.put(PATH, headers=case.auth,
        json={"expected_version": 1, "values": {**DEFAULTS, **change}})
    assert response.status_code == 422
    assert case.client.get(PATH, headers=case.auth).json() == original


def test_complete_values_and_consistent_limits_are_required(system_case):
    case = system_case
    missing = {name: value for name, value in DEFAULTS.items() if name != "upload_user_concurrency"}
    assert case.client.put(PATH, headers=case.auth,
        json={"expected_version": 1, "values": missing}).status_code == 422
    for changes, message in (({"upload_user_concurrency": 17}, "每用户上传"),
                             ({"upload_body_timeout_seconds": 10}, "上传空闲超时")):
        response = case.client.put(PATH, headers=case.auth,
            json={"expected_version": 1, "values": {**DEFAULTS, **changes}})
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "SYSTEM_SETTINGS_INVALID"
        assert message in response.json()["detail"]["message"]


def test_environment_only_seeds_once_and_initializer_leaves_commit_to_caller(system_case):
    with session_factory()() as db:
        seeded = initialize_system_settings(db)
        assert seeded.version == 1 and seeded.values == DEFAULTS
        db.rollback()
        assert db.get(SystemSettings, 1) is None
        initial = settings_json(initialize_system_settings(db))
        db.commit()
    # Even inconsistent later environment defaults must not replace or prevent
    # reading the administrator's already persisted settings on process restart.
    settings().upload_user_concurrency = 32
    settings().upload_global_concurrency = 1
    with session_factory()() as db:
        assert settings_json(initialize_system_settings(db)) == initial
        assert get_request_limits(db).model_dump() == DEFAULTS


def test_request_snapshots_refresh_without_extra_connections_or_implicit_commit(system_case):
    case = system_case
    case.client.get(PATH, headers=case.auth).raise_for_status()
    options = {"connect_args": {"check_same_thread": False}} if engine().dialect.name == "sqlite" else {}
    single = create_engine(engine().url, pool_size=1, max_overflow=0, pool_timeout=.5, **options)
    try:
        with Session(bind=single) as db:
            previous = get_request_limits(db)
            with pytest.raises(ValidationError):
                previous.upload_user_concurrency = 1
            values = {**DEFAULTS, "upload_global_concurrency": 24}
            case.client.put(PATH, headers=case.auth,
                json={"expected_version": 1, "values": values}).raise_for_status()
            assert get_request_limits(db).upload_global_concurrency == 24
            assert previous.upload_global_concurrency == 16
            reader = db.get(User, case.reader_id)
            reader.name = "uncommitted name"
            assert get_request_limits(db).upload_global_concurrency == 24
            db.rollback()
            assert db.get(User, case.reader_id).name == "Reader"
    finally:
        single.dispose()


def test_concurrent_initialization_chooses_one_seed(system_case):
    barrier = Barrier(6)

    def initialize(_):
        with session_factory()() as db:
            barrier.wait(timeout=10)
            result = settings_json(initialize_system_settings(db))
            db.commit()
            return result

    with ThreadPoolExecutor(max_workers=6) as executor:
        results = list(executor.map(initialize, range(6)))
    assert all(result == results[0] for result in results)
    with session_factory()() as db:
        assert len(db.scalars(select(SystemSettings)).all()) == 1


def test_concurrent_updates_cannot_overwrite_another_administrator(system_case):
    case = system_case
    case.client.get(PATH, headers=case.auth).raise_for_status()
    barrier = Barrier(2)

    def change(rate):
        with session_factory()() as db:
            user = db.get(User, case.owner_id)
            body = SystemSettingsUpdate(expected_version=1, values={**DEFAULTS, "feedback_requests_per_minute": rate})
            barrier.wait(timeout=10)
            try:
                return put_system_settings(body, user, db)
            except HTTPException as error:
                assert error.status_code == 409 and error.detail["code"] == "SYSTEM_SETTINGS_CONFLICT"
                return None

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(change, [31, 32]))
    winners = [result for result in results if result]
    assert len(winners) == 1
    assert case.client.get(PATH, headers=case.auth).json() == winners[0]
