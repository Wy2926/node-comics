"""Private classic checkpoints and independently metered text calls."""
from alembic import op
from app.models import ClassicState, TextCall

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade():
    ClassicState.__table__.create(op.get_bind(), checkfirst=True)
    TextCall.__table__.create(op.get_bind(), checkfirst=True)


def downgrade():
    TextCall.__table__.drop(op.get_bind())
    ClassicState.__table__.drop(op.get_bind())
