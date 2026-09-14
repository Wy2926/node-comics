"""Persistent per-user admission and round-robin cursor."""
from alembic import op
import sqlalchemy as sa

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("scheduler_state",
                    sa.Column("id", sa.Integer(), primary_key=True),
                    sa.Column("last_owner_id", sa.String(36), nullable=False),
                    sa.Column("sequence", sa.BigInteger(), nullable=False),
                    sa.CheckConstraint("id = 1"))
    op.execute(sa.text("INSERT INTO scheduler_state (id, last_owner_id, sequence) VALUES (1, '', 0)"))
    op.create_table("user_queue_settings",
                    sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), primary_key=True),
                    sa.Column("concurrency", sa.Integer(), nullable=True),
                    sa.CheckConstraint("concurrency >= 1 AND concurrency <= 10"))
    op.create_table("queue_admissions",
                    sa.Column("job_id", sa.String(36), sa.ForeignKey("jobs.id"), primary_key=True),
                    sa.Column("token", sa.String(36), nullable=False, unique=True),
                    sa.Column("sequence", sa.BigInteger(), nullable=False, unique=True),
                    sa.Column("admitted_at", sa.DateTime(), nullable=False))
    op.create_index("ix_jobs_owner_status_created", "jobs", ["owner_id", "status", "created_at", "ordinal", "id"])


def downgrade():
    op.drop_index("ix_jobs_owner_status_created", table_name="jobs")
    op.drop_table("queue_admissions")
    op.drop_table("user_queue_settings")
    op.drop_table("scheduler_state")
