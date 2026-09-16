"""Loopback-only actual API entry point for ingress tests; no production startup."""
from functools import lru_cache
from pathlib import Path
import socket
import sys

from fastapi import Depends
from sqlalchemy import create_engine
import uvicorn

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.config import Settings, settings
Settings.model_config['env_file'] = None
from app import db

# One checkout is enough for ordinary routes when upload I/O holds none.
isolated_engine = create_engine(settings().database_url, pool_size=1, max_overflow=0, pool_timeout=2)
db.engine = lru_cache()(lambda: isolated_engine)
from app.main import app
from app.auth import identity


@app.get('/__isolated_test/pool')
def pool():
    return {'checkedout': isolated_engine.pool.checkedout()}


@app.get('/__isolated_test/identity')
def actual_identity(user=Depends(identity)):
    return {'id': user.id}


if __name__ == '__main__':
    ready = Path(sys.argv[1])
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]

        class ReadyServer(uvicorn.Server):
            async def startup(self, sockets=None):
                await super().startup(sockets=sockets)
                if self.started:
                    ready.write_text(str(port), encoding='ascii')

        # The parent has already created the random isolated schema and seeded
        # users. All HTTP middleware, auth, leases and upload routing are real.
        ReadyServer(uvicorn.Config(app, host='127.0.0.1', port=port, lifespan='off',
                                  access_log=False, log_level='critical')).run(sockets=[listener])
