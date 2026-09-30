"""Read bounded operational state, without reloading models or contacting center."""
from datetime import datetime, timezone
import json
from pathlib import Path
import sys


def healthy(path, now=None):
    try:
        value = json.loads(Path(path).read_text())
        age = ((now or datetime.now(timezone.utc)) -
               datetime.fromisoformat(value['updated_at'])).total_seconds()
        return (0 <= age < 60 and value['phase'] == 'running'
                and value['connected'] is True and value['loop_age_seconds'] < 120)
    except (OSError, ValueError, KeyError, TypeError):
        return False


if __name__ == '__main__':
    sys.exit(0 if healthy('/data/state/status.json') else 1)
