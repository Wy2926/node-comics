"""Serve the React administration build from the API origin; data requires admin auth."""
from pathlib import Path
from urllib.parse import urlsplit
from fastapi import APIRouter
from fastapi.responses import FileResponse
from .config import settings

router = APIRouter()
ROOT = Path(__file__).parent / "admin_web" / "dist"


def page(filename):
    from .errors import problem
    target = (ROOT / filename).resolve()
    if not target.is_relative_to(ROOT.resolve()) or not target.is_file():
        problem("ADMIN_NOT_BUILT", "请先构建后台前端：cd backend/admin-ui && npm ci && npm run build", 503)
    token_url = urlsplit(settings().oidc_token_endpoint)
    token_origin = f"{token_url.scheme}://{token_url.netloc}" if token_url.scheme in {"http", "https"} and token_url.netloc else ""
    return FileResponse(target, headers={"Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; "
        f"connect-src 'self' {token_origin}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"})


@router.get("/admin", include_in_schema=False)
@router.get("/admin/", include_in_schema=False)
def admin_page():
    return page("index.html")


@router.get("/admin/assets/{filename}", include_in_schema=False)
def admin_asset(filename: str):
    from .errors import problem
    if not filename.endswith((".js", ".css")) or "/" in filename or "\\" in filename:
        problem("NOT_FOUND", "文件不存在", 404)
    return page("assets/" + filename)
