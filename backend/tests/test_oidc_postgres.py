"""First OIDC login contention in the dedicated disposable PostgreSQL schema."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Barrier
from types import SimpleNamespace
import jwt
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import event, func, select
from test_postgres_concurrency import pg_scope, pytestmark


def test_postgres_concurrent_first_oidc_login_creates_one_user(pg_scope, monkeypatch):
    from app import auth
    from app.config import settings
    from app.db import engine, initialize, session_factory
    from app.models import User
    initialize()
    cfg = settings()
    cfg.dev_auth = False
    cfg.oidc_issuer = "https://identity.example.test/oidc"
    cfg.oidc_audience = "https://comics.example.test/api"
    cfg.oidc_jwks_url = cfg.oidc_issuer + "/jwks"
    key = ec.generate_private_key(ec.SECP384R1())
    monkeypatch.setattr(auth, "jwks_client", lambda: SimpleNamespace(
        get_signing_key_from_jwt=lambda token: SimpleNamespace(key=key.public_key())))
    claims = {"iss": cfg.oidc_issuer, "aud": cfg.oidc_audience, "sub": "same-first-login",
              "roles": [cfg.oidc_admin_role], "exp": datetime.now(timezone.utc) + timedelta(minutes=5)}
    credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=jwt.encode(claims, key, algorithm="ES384"))
    barrier = Barrier(8)

    def simultaneous_insert(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith("INSERT INTO users"):
            barrier.wait(timeout=10)

    def login(_):
        with session_factory()() as db:
            user = auth.identity(credentials, db)
            # The same session must remain usable after a uniqueness conflict.
            assert db.scalar(select(func.count()).select_from(User)) == 1
            return user.id, user.role

    event.listen(engine(), "before_cursor_execute", simultaneous_insert)
    try:
        with ThreadPoolExecutor(8) as pool:
            users = list(pool.map(login, range(8)))
    finally:
        event.remove(engine(), "before_cursor_execute", simultaneous_insert)
    assert len(set(users)) == 1
    assert users[0][1] == "admin"
    with session_factory()() as db:
        assert db.scalar(select(func.count()).select_from(User)) == 1
    # Subsequent claims must still revoke privileges normally.
    claims["roles"] = []
    credentials.credentials = jwt.encode(claims, key, algorithm="ES384")
    with session_factory()() as db:
        assert auth.identity(credentials, db).role == "user"
