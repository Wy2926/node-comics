"""Export the running local API's public contract; no account or provider calls."""
import json
import urllib.request
from pathlib import Path

with urllib.request.urlopen("http://127.0.0.1:18088/openapi.json", timeout=15) as response:
    schema = json.load(response)
target = Path(__file__).resolve().parents[1] / "contracts" / "openapi.json"
target.parent.mkdir(exist_ok=True)
target.write_text(json.dumps(schema, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Exported {len(schema['paths'])} paths to {target}")
