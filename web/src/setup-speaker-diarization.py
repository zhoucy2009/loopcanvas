"""Install an isolated, local sherpa-onnx runtime from official distributions."""
import hashlib
import json
import pathlib
import subprocess
import sys
import tarfile
import urllib.request

root = pathlib.Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)
python = root / "venv/bin/python3"
if not python.exists():
    subprocess.run([sys.executable, "-m", "venv", str(root / "venv")], check=True)
subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir", "sherpa-onnx==1.13.7", "numpy==2.2.6"], check=True)
base = "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
assets = {
    "segmentation.tar.bz2": base + "speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
    "embedding.onnx": base + "speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
}
for name, url in assets.items():
    destination = root / name
    if not destination.exists():
        print("Downloading", name, flush=True)
        temporary = root / (name + ".partial")
        with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        temporary.replace(destination)
with tarfile.open(root / "segmentation.tar.bz2", "r:bz2") as archive:
    for source, target in [("model.onnx", "segmentation.onnx"), ("LICENSE", "segmentation-LICENSE")]:
        member = next(m for m in archive.getmembers() if m.isfile() and pathlib.PurePosixPath(m.name).name == source)
        (root / target).write_bytes(archive.extractfile(member).read())
expected = {"segmentation.onnx": "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079", "embedding.onnx": "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b"}
for name, digest in expected.items():
    if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
        raise ValueError("Model checksum mismatch: " + name)
subprocess.run([str(python), "-c", "import sherpa_onnx, numpy; print('speaker runtime ready')"], check=True)
manifest = {"engine": "sherpa-onnx", "version": "1.13.7", "sources": assets, "models": {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in ["segmentation.onnx", "embedding.onnx"]}}
(root / "manifest.json").write_text(json.dumps(manifest, indent=2))
print(json.dumps(manifest), flush=True)
