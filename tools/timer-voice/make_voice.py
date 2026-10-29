import argparse
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request


ENGINE = "kokoro-onnx"
VOICE = "af_heart"
SPEED = 1.0
MODEL_BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/"
WEBSITE = Path(__file__).resolve().parents[2]
OUTPUT = WEBSITE / "timer" / "voice"
NUMBER = r"\d+(?:\.\d+)?"


def normalize(text):
    text = re.sub(r"\b90\s*/\s*90\b", "ninety-ninety", text)
    text = re.sub(
        rf"\b({NUMBER})\s*[x×]\s*({NUMBER})\b",
        lambda match: f"{match[1]} {'set' if float(match[1]) == 1 else 'sets'} of {match[2]}",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(rf"\b({NUMBER})\s*[-–]\s*({NUMBER})\b", r"\1 to \2", text)
    text = re.sub(
        rf"\b({NUMBER}(?:\s+to\s+{NUMBER})?)\s*min\b",
        lambda match: f"{match[1]} {'minute' if 'to' not in match[1] and float(match[1]) == 1 else 'minutes'}",
        text,
    )
    return re.sub(
        rf"\b({NUMBER})\s*s\b",
        lambda match: f"{match[1]} {'second' if float(match[1]) == 1 else 'seconds'}",
        text,
    )


def likely_misreads(text):
    patterns = (
        r"\b[A-Z]{2,}\b", r"\b\d+(?:\.\d+)?\s*(?:min|cm|kg|lb|lbs)\b",
        r"\b\d+\s*/\s*\d+\b", r"(?i:\b(?:Cossack|thoracic|lumbrical|Vagy|Cardwell|EpicTV)\b)",
    )
    return sorted({match[0] for pattern in patterns for match in re.finditer(pattern, text)})


def run(command):
    try:
        return subprocess.run(command, check=True, capture_output=True, text=True, encoding="utf-8")
    except subprocess.CalledProcessError as error:
        logging.exception("Command failed: %s\nstdout:\n%s\nstderr:\n%s", command, error.stdout, error.stderr)
        raise


def clip_name(cue):
    return hashlib.sha256(cue.encode("utf-8")).hexdigest()[:16] + ".mp3"


def valid_clip(path):
    if not path.exists():
        return False
    try:
        probe = json.loads(run([
            "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path),
        ]).stdout)
        streams = probe["streams"]
        if (len(streams) != 1 or streams[0]["codec_name"] != "mp3"
                or streams[0]["channels"] != 1 or streams[0]["sample_rate"] != "24000"
                or int(streams[0]["bit_rate"]) != 48000 or float(probe["format"]["duration"]) <= 0):
            raise ValueError(f"Clip does not meet the mono 24 kHz 48 kbps MP3 format: {path}")
        run(["ffmpeg", "-v", "error", "-xerror", "-i", str(path), "-f", "null", "-"])
    except (subprocess.CalledProcessError, ValueError, KeyError, TypeError) as error:
        logging.exception("Invalid clip; it will be regenerated if required: %s (%s)", path, error)
        return False
    return True


def download(cache, filename):
    target = cache / filename
    if target.exists():
        if target.stat().st_size == 0:
            raise ValueError(f"Empty model data: {target}")
        return target
    logging.info("Downloading once: %s", MODEL_BASE + filename)
    with tempfile.TemporaryDirectory(dir=cache) as temporary:
        pending = Path(temporary) / filename
        with urllib.request.urlopen(MODEL_BASE + filename, timeout=120) as response, pending.open("wb") as output:
            shutil.copyfileobj(response, output)
        if pending.stat().st_size == 0:
            raise ValueError(f"Empty model download: {filename}")
        pending.replace(target)
    return target


def write_index(clips, output, cache):
    document = {"engine": ENGINE, "voice": VOICE, "clips": clips}
    with tempfile.TemporaryDirectory(dir=cache) as temporary:
        pending = Path(temporary) / "index.json"
        pending.write_text(json.dumps(document, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        pending.replace(output / "index.json")


def review_path(value):
    path = Path(value).expanduser().resolve()
    if any((parent / ".git").exists() for parent in (path.parent, *path.parent.parents)):
        raise ValueError(f"Review must be outside every Git repository: {path}")
    return path


def generate(source, cache, review=None, prune=False):
    cues = json.loads(run(["node", str(Path(__file__).with_name("cues.mjs")), source]).stdout)
    if not isinstance(cues, list) or not cues or any(not isinstance(cue, str) or not cue.strip() for cue in cues):
        raise ValueError("cues.mjs must return a nonempty JSON array of exact, nonempty cue strings")
    cues = sorted(set(cues))
    names = [clip_name(cue) for cue in cues]
    if len(names) != len(set(names)):
        raise ValueError("Cue filenames have a SHA256 prefix collision")
    if review is not None:
        review = review_path(review)
        review.parent.mkdir(parents=True, exist_ok=True)
        review.write_text("".join(
            f"{json.dumps(cue, ensure_ascii=False)} -> {json.dumps(normalize(cue), ensure_ascii=False)}\n"
            for cue in cues
        ), encoding="utf-8")
        logging.info("Review: %s", review)
    for cue in cues:
        risks = likely_misreads(normalize(cue))
        if risks:
            logging.warning("Likely misreads %s in exact cue %r", ", ".join(risks), cue)

    clips = {}
    index = OUTPUT / "index.json"
    if index.exists():
        document = json.loads(index.read_text(encoding="utf-8"))
        if document.get("engine") != ENGINE or document.get("voice") != VOICE:
            raise ValueError(f"Existing index must use {ENGINE} / {VOICE}: {index}")
        clips = document["clips"]
        if not isinstance(clips, dict) or any(not isinstance(cue, str) or filename != clip_name(cue)
                                               for cue, filename in clips.items()):
            raise ValueError(f"Existing index has an invalid cue-to-filename mapping: {index}")

    OUTPUT.mkdir(parents=True, exist_ok=True)
    generated = 0
    kept = 0
    kokoro = None
    for cue in cues:
        filename = clip_name(cue)
        target = OUTPUT / filename
        if valid_clip(target):
            kept += 1
        else:
            if kokoro is None:
                from kokoro_onnx import Kokoro
                model = download(cache, "kokoro-v1.0.onnx")
                voices = download(cache, "voices-v1.0.bin")
                kokoro = Kokoro(str(model), str(voices))
            logging.info("Synthesizing %s: %s", filename, normalize(cue))
            samples, sample_rate = kokoro.create(normalize(cue), voice=VOICE, speed=SPEED, lang="en-us")
            if sample_rate != 24000 or len(samples) == 0:
                raise ValueError(f"Kokoro returned invalid audio for {cue!r}: {sample_rate} Hz, {len(samples)} samples")
            import numpy as np
            if not np.isfinite(samples).all() or not np.any(samples):
                raise ValueError(f"Kokoro returned non-finite or silent audio for {cue!r}")
            with tempfile.TemporaryDirectory(dir=cache) as temporary:
                pcm = Path(temporary) / "audio.f32"
                encoded = Path(temporary) / filename
                np.asarray(samples, dtype="<f4").tofile(pcm)
                run([
                    "ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", "24000", "-ac", "1",
                    "-i", str(pcm), "-codec:a", "libmp3lame", "-ac", "1", "-ar", "24000",
                    "-b:a", "48k", "-map_metadata", "-1", str(encoded),
                ])
                if not valid_clip(encoded):
                    raise ValueError(f"Encoded clip failed validation: {cue!r}")
                encoded.replace(target)
            generated += 1
        clips[cue] = filename
        write_index(clips, OUTPUT, cache)

    removed_entries = 0
    removed_files = 0
    if prune:
        removed_entries = len(set(clips) - set(cues))
        clips = {cue: clips[cue] for cue in cues}
        write_index(clips, OUTPUT, cache)
        listed = set(clips.values())
        for path in OUTPUT.glob("*.mp3"):
            if path.name not in listed:
                path.unlink()
                removed_files += 1
    size = sum((OUTPUT / clip_name(cue)).stat().st_size for cue in cues)
    logging.info("Cues: %d; generated: %d; kept: %d; MP3 bytes: %d; pruned entries: %d; pruned files: %d",
                 len(cues), generated, kept, size, removed_entries, removed_files)


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    cache = Path(os.environ["LOCALAPPDATA"]) / "timer-voice"
    expected_venv = cache / "venv"
    if sys.version_info[:2] != (3, 12) or Path(sys.prefix).resolve() != expected_venv.resolve() or sys.prefix == sys.base_prefix:
        raise RuntimeError(f"Run with Python 3.12 in {expected_venv}; got {sys.version} at {sys.executable}")
    parser = argparse.ArgumentParser(description="Generate local Kokoro-82M af_heart cues at speed 1.0")
    parser.add_argument("source", help="CSV path or HTTP(S) URL")
    parser.add_argument("--prune", action="store_true", help="Remove stale index entries and unlisted MP3 clips")
    parser.add_argument("--review", help="Write exact cue -> spoken text lines outside Git repositories")
    args = parser.parse_args()
    review = review_path(args.review) if args.review is not None else None
    for executable in ("node", "ffmpeg", "ffprobe"):
        if shutil.which(executable) is None:
            raise FileNotFoundError(f"Required executable is missing from PATH: {executable}")
    cache.mkdir(parents=True, exist_ok=True)
    generate(args.source, cache, review, args.prune)


if __name__ == "__main__":
    main()
