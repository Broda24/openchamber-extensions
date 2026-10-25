from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import json


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "dist"
FILES = (
    "package.json",
    "icon.svg",
    "README.md",
    "panel/index.html",
    "panel/styles.css",
    "panel/main.js",
)


def main() -> None:
    manifest_path = ROOT / "package.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    version = manifest["version"]
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output = OUTPUT_DIR / f"openchamber-ideenboard-{version}.zip"
    missing = [name for name in FILES if not (ROOT / name).is_file()]
    if missing:
        raise SystemExit(f"Paketdateien fehlen: {', '.join(missing)}. Zuerst `npm run build` ausführen.")

    with ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for name in FILES:
            archive.write(ROOT / name, arcname=name)

    print(output)


if __name__ == "__main__":
    main()
