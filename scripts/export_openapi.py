"""Export actual API routes with isolated configuration and no service startup."""
from argparse import ArgumentParser
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


def export_schema(target: Path):
    sys.path.insert(0, str(ROOT / "backend"))
    from app import config

    class ExportSettings(config.Settings):
        @classmethod
        def settings_customise_sources(cls, settings_cls, init_settings, env_settings,
                                       dotenv_settings, file_secret_settings):
            # Only explicit synthetic values and model defaults may affect export.
            return (init_settings,)

    isolated = ExportSettings(
        _env_file=None,
        app_env="test",
        dev_auth=True,
        dev_auth_secret="openapi-export-only-not-a-runtime-signing-key",
        database_url="sqlite:///:memory:",
        result_storage_backend="local",
        admin_web_path="",
    )
    # Imports below use the real routes, but never the caller's cached settings.
    config.settings = lambda: isolated
    from app.main import app

    schema = app.openapi()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(schema, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Exported {len(schema['paths'])} paths to {target}")


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "contracts/openapi.json")
    export_schema(parser.parse_args().output)


if __name__ == "__main__":
    main()
