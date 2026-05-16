#!/usr/bin/env python3
"""
smugmug_download.py — Pass 2 of the SmugMug → local photo-portfolio migration.

Reads the frozen manifest.json emitted by smugmug_crawl.py and downloads every
image's ArchivedUri (the untouched original) into a local photos/ tree. Only
originals are pulled; all responsive sizes, WebP/AVIF, and thumbnails are
generated downstream by the local asset pipeline.

────────────────────────────────────────────────────────────────────────────
Behavior
────────────────────────────────────────────────────────────────────────────
* **Idempotent.** Re-runs skip any file already present whose size and MD5
  match the manifest, so interrupted runs resume cheaply.
* **Atomic writes.** Each file streams into `<target>.tmp` and is renamed
  into place only after its MD5 matches `ArchivedMD5`. An interrupted run
  never leaves a half-written JPEG at the canonical path.
* **Verifies integrity.** Every download is hashed during streaming; on
  mismatch the temp file is deleted and the task retries up to MAX_RETRIES.
* **Polite concurrency.** ThreadPoolExecutor with configurable worker count
  (default 8). Retries 429/5xx with backoff, honors Retry-After. Does NOT
  retry 4xx other than 429 (a 401/403 means token lacks access — retrying
  won't fix it, and you want to know).
* **Reports.** Writes `download_report.json` listing counts and per-failure
  detail so failures can be triaged and re-run.

────────────────────────────────────────────────────────────────────────────
Layout
────────────────────────────────────────────────────────────────────────────
Files land at:

    <photos_root>/<url_path_segments>/<filename>

derived from each album's `url_path` (slug-friendly) and the image's
SmugMug `FileName`. Filename collisions within an album are disambiguated
by suffixing `__<ImageKey>` before the extension.

`photos/` should be in .gitignore — it's regenerable and will be ~110 GB.

────────────────────────────────────────────────────────────────────────────
Usage
────────────────────────────────────────────────────────────────────────────
    # same four env vars as smugmug_crawl.py (OAuth 1.0a credentials)
    python scripts/smugmug_download.py \\
        --manifest manifest.json \\
        --photos-root photos \\
        --workers 8

    # dry run / spot check — only first 50 images:
    python scripts/smugmug_download.py --limit 50 -v

────────────────────────────────────────────────────────────────────────────
Dependencies
────────────────────────────────────────────────────────────────────────────
    Python 3.10+
    pip install -r scripts/requirements.txt
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from requests_oauthlib import OAuth1


CHUNK_SIZE = 1024 * 1024          # 1 MiB streaming chunks
DEFAULT_WORKERS = 8
MAX_RETRIES = 5
RETRY_BACKOFF_SECONDS = 2.0
REQUEST_TIMEOUT = 60              # seconds per HTTP request

log = logging.getLogger("smugmug_download")


# ---------------------------------------------------------------------------
# Task / result types
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class DownloadTask:
    album_url_path: str
    album_segments: tuple[str, ...]
    image_key: str
    filename: str
    archived_uri: str
    archived_md5: str | None
    archived_size: int | None


@dataclass
class DownloadResult:
    image_key: str
    target: Path
    status: str                   # "downloaded" | "skipped" | "failed"
    bytes_written: int = 0
    error: str | None = None


# ---------------------------------------------------------------------------
# Path / task construction
# ---------------------------------------------------------------------------

_BAD_PATH_CHARS = str.maketrans({"/": "_", "\\": "_", "\0": ""})


def sanitize(segment: str) -> str:
    """Make a single path segment filesystem-safe (no separators, no NULs)."""
    cleaned = (segment or "").translate(_BAD_PATH_CHARS).strip()
    return cleaned or "_"


def disambiguate(filename: str, image_key: str) -> str:
    """Append __<image_key> before the extension to break a duplicate name."""
    stem, dot, ext = filename.rpartition(".")
    if dot:
        return f"{stem}__{image_key}.{ext}"
    return f"{filename}__{image_key}"


def build_tasks(manifest: dict) -> list[DownloadTask]:
    """Project manifest album entries into a flat list of DownloadTask."""
    tasks: list[DownloadTask] = []
    for node in manifest.get("nodes", []):
        if node.get("type") != "album":
            continue
        segments = tuple(
            sanitize(s) for s in (node.get("url_path") or "").lstrip("/").split("/") if s
        )
        if not segments:
            continue
        used: dict[str, int] = {}
        for img in node.get("images", []):
            uri = img.get("archived_uri")
            key = img.get("image_key")
            if not uri or not key:
                continue
            base = sanitize(img.get("filename") or f"{key}.jpg")
            count = used.get(base, 0)
            used[base] = count + 1
            filename = base if count == 0 else disambiguate(base, key)
            tasks.append(
                DownloadTask(
                    album_url_path=node.get("url_path", ""),
                    album_segments=segments,
                    image_key=key,
                    filename=filename,
                    archived_uri=uri,
                    archived_md5=(img.get("archived_md5") or None),
                    archived_size=img.get("archived_size"),
                )
            )
    return tasks


# ---------------------------------------------------------------------------
# HTTP / IO helpers
# ---------------------------------------------------------------------------

def make_session(
    api_key: str, api_secret: str,
    access_token: str, access_token_secret: str,
) -> requests.Session:
    """Build a Session signed for SmugMug OAuth 1.0a.

    requests strips Authorization on cross-origin redirects by default, so
    when SmugMug 302s ArchivedUri to its photos.smugmug.com CDN host the
    signed header drops away cleanly and the CDN's own tokened URL is
    fetched anonymously. This is intentional and works for both public
    and private albums (as long as the access token can see them).
    """
    session = requests.Session()
    session.auth = OAuth1(
        api_key,
        client_secret=api_secret,
        resource_owner_key=access_token,
        resource_owner_secret=access_token_secret,
        signature_type="auth_header",
    )
    return session


def md5_of_file(path: Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(CHUNK_SIZE), b""):
            h.update(chunk)
    return h.hexdigest()


def human(n: float) -> str:
    f = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if f < 1024:
            return f"{f:.2f} {unit}"
        f /= 1024
    return f"{f:.2f} PB"


# ---------------------------------------------------------------------------
# Per-file download
# ---------------------------------------------------------------------------

def already_good(target: Path, task: DownloadTask) -> bool:
    """True if target exists, has the expected size, and hashes to ArchivedMD5.

    Size is checked first to avoid hashing files that are obviously stale.
    If the manifest lacks an MD5, fall back to size-only equality.
    """
    if not target.exists():
        return False
    if task.archived_size is not None and target.stat().st_size != task.archived_size:
        return False
    if not task.archived_md5:
        return True
    return md5_of_file(target).lower() == task.archived_md5.lower()


def download_one(
    task: DownloadTask,
    session: requests.Session,
    photos_root: Path,
) -> DownloadResult:
    target = photos_root.joinpath(*task.album_segments, task.filename)

    if already_good(target, task):
        return DownloadResult(task.image_key, target, "skipped")

    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")

    last_error: str | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with session.get(
                task.archived_uri,
                stream=True,
                timeout=REQUEST_TIMEOUT,
                allow_redirects=True,
            ) as response:
                # 429 → wait and retry; 4xx (other than 429) → permanent
                if response.status_code == 429:
                    sleep_s = float(
                        response.headers.get("Retry-After", RETRY_BACKOFF_SECONDS * attempt)
                    )
                    log.warning("429 on %s; sleeping %.1fs", task.archived_uri, sleep_s)
                    time.sleep(sleep_s)
                    continue
                if 400 <= response.status_code < 500:
                    return DownloadResult(
                        task.image_key, target, "failed", 0,
                        f"HTTP {response.status_code} (no retry on 4xx)",
                    )
                response.raise_for_status()

                hasher = hashlib.md5()
                bytes_written = 0
                with tmp.open("wb") as fh:
                    for chunk in response.iter_content(chunk_size=CHUNK_SIZE):
                        if not chunk:
                            continue
                        fh.write(chunk)
                        hasher.update(chunk)
                        bytes_written += len(chunk)

            # Verify integrity before publishing the file.
            if task.archived_md5:
                got = hasher.hexdigest().lower()
                if got != task.archived_md5.lower():
                    tmp.unlink(missing_ok=True)
                    last_error = f"MD5 mismatch: expected {task.archived_md5}, got {got}"
                    log.warning("%s — %s (attempt %d)", target, last_error, attempt)
                    time.sleep(RETRY_BACKOFF_SECONDS * attempt)
                    continue
            if task.archived_size is not None and bytes_written != task.archived_size:
                tmp.unlink(missing_ok=True)
                last_error = (
                    f"size mismatch: expected {task.archived_size}, got {bytes_written}"
                )
                log.warning("%s — %s (attempt %d)", target, last_error, attempt)
                time.sleep(RETRY_BACKOFF_SECONDS * attempt)
                continue

            os.replace(tmp, target)
            return DownloadResult(task.image_key, target, "downloaded", bytes_written)

        except requests.RequestException as exc:
            last_error = str(exc)
            tmp.unlink(missing_ok=True)
            sleep_s = RETRY_BACKOFF_SECONDS * (2 ** (attempt - 1))
            log.warning(
                "Network error on %s: %s; retrying in %.1fs (attempt %d)",
                task.archived_uri, exc, sleep_s, attempt,
            )
            time.sleep(sleep_s)
            continue

    return DownloadResult(
        task.image_key, target, "failed", 0,
        last_error or "exhausted retries",
    )


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

REQUIRED_ENV = (
    "SMUGMUG_API_KEY",
    "SMUGMUG_API_SECRET",
    "SMUGMUG_ACCESS_TOKEN",
    "SMUGMUG_ACCESS_TOKEN_SECRET",
)


def load_credentials() -> tuple[str, str, str, str]:
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        sys.exit(
            "Missing required environment variables: "
            + ", ".join(missing)
            + "\nUse scripts/smugmug_auth.py to mint the access token if needed."
        )
    return tuple(os.environ[name] for name in REQUIRED_ENV)  # type: ignore[return-value]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Pass 2: download all originals listed in manifest.json.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--manifest", default=Path("manifest.json"), type=Path,
        help="Path to the manifest produced by smugmug_crawl.py (default: manifest.json).",
    )
    parser.add_argument(
        "--photos-root", default=Path("photos"), type=Path,
        help="Local directory tree to write originals into (default: photos/).",
    )
    parser.add_argument(
        "--workers", type=int, default=DEFAULT_WORKERS,
        help=f"Concurrent download workers (default: {DEFAULT_WORKERS}).",
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Only process the first N images. Useful for smoke-testing.",
    )
    parser.add_argument(
        "--report", default=Path("download_report.json"), type=Path,
        help="Path to write the JSON report at end of run.",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true",
        help="Enable debug-level logging (per-file).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    credentials = load_credentials()
    session = make_session(*credentials)

    if not args.manifest.exists():
        sys.exit(f"Manifest not found: {args.manifest}")
    manifest = json.loads(args.manifest.read_text())

    tasks = build_tasks(manifest)
    if args.limit:
        tasks = tasks[: args.limit]

    total_expected_bytes = sum((t.archived_size or 0) for t in tasks)
    log.info(
        "Loaded %d image tasks (%s expected) from %s",
        len(tasks), human(total_expected_bytes), args.manifest,
    )
    log.info("Writing to %s with %d workers", args.photos_root, args.workers)
    args.photos_root.mkdir(parents=True, exist_ok=True)

    results: list[DownloadResult] = []
    counters = {"downloaded": 0, "skipped": 0, "failed": 0, "bytes": 0}
    lock = threading.Lock()
    started = time.monotonic()

    def emit_progress() -> None:
        elapsed = max(time.monotonic() - started, 1e-6)
        done = counters["downloaded"] + counters["skipped"] + counters["failed"]
        pct = (done / len(tasks) * 100) if tasks else 100.0
        rate = counters["bytes"] / elapsed
        log.info(
            "Progress: %d/%d (%.1f%%)  +%s  downloaded=%d  skipped=%d  failed=%d  [%s/s]",
            done, len(tasks), pct, human(counters["bytes"]),
            counters["downloaded"], counters["skipped"], counters["failed"],
            human(rate),
        )

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(download_one, task, session, args.photos_root): task
            for task in tasks
        }
        for i, future in enumerate(as_completed(futures), 1):
            result = future.result()
            with lock:
                results.append(result)
                counters[result.status] += 1
                counters["bytes"] += result.bytes_written
            if result.status == "failed":
                log.error("FAILED %s — %s", result.target, result.error)
            elif args.verbose:
                log.debug(
                    "%s %s (%s)", result.status, result.target,
                    human(result.bytes_written) if result.bytes_written else "—",
                )
            if i % 100 == 0:
                emit_progress()

    emit_progress()
    elapsed = time.monotonic() - started
    log.info("Done in %.1fs", elapsed)

    report = {
        "completed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "manifest": str(args.manifest),
        "photos_root": str(args.photos_root),
        "workers": args.workers,
        "elapsed_seconds": round(elapsed, 2),
        "total_tasks": len(tasks),
        "downloaded": counters["downloaded"],
        "skipped": counters["skipped"],
        "failed": counters["failed"],
        "bytes_written": counters["bytes"],
        "failures": [
            {
                "image_key": r.image_key,
                "target": str(r.target),
                "error": r.error,
            }
            for r in results if r.status == "failed"
        ],
    }
    args.report.write_text(json.dumps(report, indent=2))
    log.info("Wrote report → %s", args.report)

    if counters["failed"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
