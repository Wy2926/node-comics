"""Export this checkout's public contract without starting DB/worker/provider calls."""
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "backend"))
from app.main import app

schema = app.openapi()
target = root / "contracts" / "openapi.json"
target.parent.mkdir(exist_ok=True)
target.write_text(json.dumps(schema, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Exported {len(schema['paths'])} paths to {target}")
