"""Explicit visitor identities; preserve registered accounts and all ownership."""
from alembic import op
import sqlalchemy as sa

revision = 'website_guests_0010'
down_revision = 'simple_scheduler_0009'
branch_labels = None
depends_on = None


def upgrade():
    connection = op.get_bind()
    sqlite = connection.dialect.name == 'sqlite'
    if sqlite:
        if not connection.connection.driver_connection.in_transaction:
            connection.exec_driver_sql('BEGIN IMMEDIATE')
        connection.exec_driver_sql('PRAGMA defer_foreign_keys = ON')
    checks = tuple(sa.CheckConstraint(c['sqltext']) for c in sa.inspect(connection).get_check_constraints('users') if not c['name'])
    with op.batch_alter_table('users', table_args=checks) as batch:
        batch.add_column(sa.Column('kind', sa.String(16), nullable=False, server_default='registered'))
        batch.alter_column('subject', existing_type=sa.String(255), nullable=True)
        batch.create_index('ix_users_kind', ['kind'])
        batch.create_check_constraint('ck_user_identity', "(kind = 'registered' AND subject IS NOT NULL) OR "
            "(kind = 'guest' AND subject IS NULL AND role = 'user' AND membership_id IS NULL "
            "AND plus_started_at IS NULL AND plus_expires_at IS NULL AND plus_timezone IS NULL "
            "AND plus_monthly_pages IS NULL AND NOT plus_pending)")
    if sqlite:
        if connection.exec_driver_sql('PRAGMA foreign_key_check').first():
            raise RuntimeError('Visitor migration must preserve ownership references')
        connection.exec_driver_sql('PRAGMA defer_foreign_keys = OFF')
    from app.guest_models import GuestSession, GuestDailyUsage, GuestDailyBudget
    for model in (GuestSession, GuestDailyUsage, GuestDailyBudget):
        model.__table__.create(connection)
    op.create_index('ix_jobs_guest_expiry', 'jobs', ['completed_at'],
        sqlite_where=sa.text("quota_kind = 'guest_trial' AND discard_output IS 0"),
        postgresql_where=sa.text("quota_kind = 'guest_trial' AND discard_output IS FALSE"))


def downgrade():
    raise RuntimeError('Visitor ownership and admission receipts require the matching application; restore a consistent backup to roll back')
