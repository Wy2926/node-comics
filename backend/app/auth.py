from functools import lru_cache
from datetime import timedelta
import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from .config import settings
from .db import get_db
from .errors import problem
from .models import User, now

bearer = HTTPBearer(auto_error=False)


@lru_cache
def jwks_client():
    cfg = settings()
    # Per-key LRU caches have no expiry and bypass JWKS revocation indefinitely.
    # Retain only the bounded whole-set cache; an expired set must refresh or fail.
    return jwt.PyJWKClient(cfg.oidc_jwks_url, cache_keys=False, cache_jwk_set=True,
                          lifespan=cfg.oidc_jwks_cache_seconds, timeout=cfg.oidc_jwks_timeout_seconds)


def token_for(user: User):
    cfg = settings()
    if not cfg.dev_auth or len(cfg.dev_auth_secret) < 32:
        problem("AUTH_UNCONFIGURED", "本地登录未启用，或本地签名密钥不足 32 字符", 503)
    return jwt.encode({"sub": user.subject, "iss": "node-comics-local", "aud": "node-comics", "exp": now() + timedelta(hours=12)}, cfg.dev_auth_secret, algorithm="HS256")


def identity(credentials: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)):
    if not credentials:
        problem("AUTH_REQUIRED", "请先登录后使用翻译服务", 401)
    cfg = settings()
    try:
        if cfg.dev_auth:
            claims = jwt.decode(credentials.credentials, cfg.dev_auth_secret, algorithms=["HS256"], audience="node-comics", issuer="node-comics-local", options={"require": ["exp", "sub", "iss", "aud"]})
        else:
            if not all([cfg.oidc_issuer, cfg.oidc_audience, cfg.oidc_jwks_url]):
                problem("AUTH_UNCONFIGURED", "管理员尚未配置身份服务", 503)
            key = jwks_client().get_signing_key_from_jwt(credentials.credentials)
            claims = jwt.decode(credentials.credentials, key.key, algorithms=["RS256", "ES256", "ES384"], audience=cfg.oidc_audience, issuer=cfg.oidc_issuer, options={"require": ["exp", "sub", "iss", "aud"]})
    except jwt.PyJWTError:
        problem("TOKEN_INVALID", "登录已过期，请重新登录", 401)
    if not isinstance(claims["sub"], str) or not claims["sub"]:
        problem("TOKEN_INVALID", "身份令牌无效", 401)
    subject = claims["sub"] if cfg.dev_auth else f"{cfg.oidc_issuer}|{claims['sub']}"
    if len(subject) > 255:
        problem("TOKEN_INVALID", "身份令牌无效", 401)
    user = db.scalar(select(User).where(User.subject == subject))
    if not user:
        if cfg.dev_auth:
            problem("TOKEN_INVALID", "本地用户不存在", 401)
        roles = claims.get("roles", [])
        role = "admin" if isinstance(roles, list) and cfg.oidc_admin_role in roles else "user"
        user = User(subject=subject, name=str(claims.get("name", "漫画读者"))[:80], role=role)
        db.add(user)
        try:
            db.commit()
        except IntegrityError:
            # Another first request may commit this same issuer/subject while we
            # insert. Roll back the failed transaction and reuse its unique user.
            db.rollback()
            user = db.scalar(select(User).where(User.subject == subject))
            if user is None:
                raise
    if not cfg.dev_auth:
        roles = claims.get("roles", [])
        role = "admin" if isinstance(roles, list) and cfg.oidc_admin_role in roles else "user"
        if role != user.role:
            user.role = role
            db.commit()
    return user


def admin(user: User = Depends(identity)):
    if user.role != "admin":
        problem("FORBIDDEN", "需要管理员权限", 403)
    return user


def user_json(user):
    return {"id": user.id, "name": user.name, "role": user.role}
