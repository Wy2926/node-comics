"""Weighted routing for body and title requests."""
from alembic import op
import sqlalchemy as sa

revision = 'text_routing_0003'
down_revision = 'comic_titles_0002'
branch_labels = None
depends_on = None


def upgrade():
    for purpose, old in (('text', 'is_default'), ('title', 'is_title_default')):
        weight = purpose + '_weight'
        op.add_column('translation_providers', sa.Column(weight, sa.Integer(),
            sa.CheckConstraint(f'{weight} BETWEEN 0 AND 10000', name=f'ck_translation_{weight}'),
            nullable=False, server_default='0'))
        op.execute(sa.text(f'UPDATE translation_providers SET {weight} = CASE WHEN {old} THEN 1 ELSE 0 END'))
        op.drop_index('uq_translation_default' if purpose == 'text' else 'uq_translation_title_default', table_name='translation_providers')
        op.drop_column('translation_providers', old)


def downgrade():
    for purpose, old in (('text', 'is_default'), ('title', 'is_title_default')):
        weight = purpose + '_weight'
        op.add_column('translation_providers', sa.Column(old, sa.Boolean(), nullable=False, server_default=sa.false()))
        op.execute(sa.text(f'UPDATE translation_providers SET {old} = true WHERE id = '
            f'(SELECT id FROM translation_providers WHERE {weight} > 0 ORDER BY {weight} DESC, id LIMIT 1)'))
        op.create_index('uq_translation_default' if purpose == 'text' else 'uq_translation_title_default',
            'translation_providers', [old], unique=True, sqlite_where=sa.text(f'{old} = 1'), postgresql_where=sa.text(old))
        if op.get_bind().dialect.name == 'postgresql':
            op.drop_constraint(f'ck_translation_{weight}', 'translation_providers', type_='check')
        op.drop_column('translation_providers', weight)
