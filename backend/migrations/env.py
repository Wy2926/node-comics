from alembic import context
from app.db import Base, engine
from app import models, translation_models
from app import file_pages
from app import queue_models
from app import job_requests
from app import reader_api
from app import health_models, upload_models, entitlement_models
from app import billing_models

if context.is_offline_mode():
    from app.config import settings
    context.configure(url=settings().database_url, target_metadata=Base.metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
elif context.config.attributes.get("connection") is not None:
    connection = context.config.attributes["connection"]
    context.configure(connection=connection, target_metadata=Base.metadata)
    with context.begin_transaction():
        context.run_migrations()
else:
    with engine().connect() as connection:
        context.configure(connection=connection, target_metadata=Base.metadata)
        with context.begin_transaction():
            context.run_migrations()
