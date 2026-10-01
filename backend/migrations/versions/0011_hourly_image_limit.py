"""Optional rolling hourly admission in immutable membership benefits."""
from alembic import op
import sqlalchemy as sa

revision = 'hourly_image_limit_0011'
down_revision = 'website_guests_0010'
branch_labels = None
depends_on = None


def upgrade():
    # Inline CHECK permits an additive ALTER on both SQLite and PostgreSQL;
    # existing immutable revisions and foreign-key references are untouched.
    op.add_column('billing_plan_revisions', sa.Column('hourly_image_limit', sa.Integer(),
        sa.CheckConstraint('hourly_image_limit IS NULL OR (hourly_image_limit > 0 AND hourly_image_limit <= 1000000)',
            name='ck_billing_revision_hourly_image_limit'), nullable=True))


def downgrade():
    # Downgrade would silently remove purchased limits while retaining terms.
    raise RuntimeError('Hourly membership benefits require the matching application; restore a consistent backup to roll back')
