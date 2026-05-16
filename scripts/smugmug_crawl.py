#!/usr/bin/env python3
"""
smugmug_crawl.py — Pass 1 of the SmugMug → local photo-portfolio migration.

Walks the authenticated SmugMug user's node tree (folders and albums only)
and emits a single manifest.json describing every folder, album, and image.

This pass fetches *metadata only* — no binary downloads. The resulting
manifest is the frozen input for pass 2 (smugmug_download.py), and is also
the source of truth from which the SSG content frontmatter is generated.

────────────────────────────────────────────────────────────────────────────
Scope
────────────────────────────────────────────────────────────────────────────
Included:
    * Folders (their privacy state gates everything inside them)
    * Albums (privacy, password, sort method, description, keywords)
    * Image metadata (filename, ArchivedUri, ArchivedMD5, ArchivedSize,
      caption, keywords, capture date)

Explicitly excluded:
    * Video assets        — filtered out (IsVideo == true)
    * SmugMug Pages       — node type "Page" is skipped silently
    * Comments, favorites, view counts, share stats
    * Pricelists / e-commerce settings (will be rebuilt in Stripe/Snipcart)
    * EXIF — extracted authoritatively from the downloaded originals
             in pass 2, not refetched over the API here

────────────────────────────────────────────────────────────────────────────
Usage
────────────────────────────────────────────────────────────────────────────
    export SMUGMUG_API_KEY=...
    export SMUGMUG_API_SECRET=...
    export SMUGMUG_ACCESS_TOKEN=...
    export SMUGMUG_ACCESS_TOKEN_SECRET=...
    python scripts/smugmug_crawl.py --nickname <your-smugmug-nickname> \\
                                    --output manifest.json

    # Verbose (per-request logging):
    python scripts/smugmug_crawl.py --nickname ... -v

Obtain OAuth credentials at https://api.smugmug.com/api/developer/apply.
Account owners may self-issue an access token (no 3-legged flow needed) on
the same page after creating an app — pick "Full" access so private albums
and the Password field are returned.

Tokens are read from the environment, never from argv, so they don't leak
into shell history or `ps` output.

────────────────────────────────────────────────────────────────────────────
Dependencies
────────────────────────────────────────────────────────────────────────────
    Python 3.10+
    pip install -r scripts/requirements.txt
    (i.e. requests, requests-oauthlib)

────────────────────────────────────────────────────────────────────────────
Manifest schema
────────────────────────────────────────────────────────────────────────────
    {
      "smugmug_nickname": "<nickname>",
      "crawled_at":       "2026-05-15T19:42:11Z",
      "folder_count":     N,
      "album_count":      M,
      "image_count":      K,
      "nodes": [
        {
          "type":          "folder" | "album",
          "node_id":       "<smugmug NodeID>",
          "name":          "Album / Folder display name",
          "url_name":      "Url-Slug",
          "url_path":      "/Parent/Child/Url-Slug",
          "path":          ["Parent", "Child", "Album"],
          "description":   "...",
          "keywords":      ["..."],
          "date_added":    "ISO-8601",
          "privacy":       "Public" | "Unlisted" | "Private",
          "security_type": "None"   | "Password" | "GrantAccess",
          "password":      "..." | null,
          "password_hint": "..." | null,

          # Album-only fields:
          "album_key":     "<AlbumKey>",
          "sort_method":   "DateTaken" | "Position" | ...,
          "image_count":   N,
          "images": [
            {
              "image_key":     "<ImageKey>",
              "filename":      "DSC_0001.jpg",
              "caption":       "...",
              "keywords":      ["..."],
              "archived_uri":  "https://photos.smugmug.com/.../O/...jpg",
              "archived_md5":  "<md5 hex>",
              "archived_size": 12345678,
              "date":          "ISO-8601 capture/upload date",
              "format":        "JPG" | "RAW" | ...
            }, ...
          ]
        },
        ...
      ]
    }

Nodes are emitted in depth-first folder order — a folder appears in the
list immediately before its descendants — so the manifest can be read
sequentially to reconstruct the on-site hierarchy.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import requests
from requests_oauthlib import OAuth1


API_BASE = "https://api.smugmug.com"
PAGE_SIZE = 100
MAX_RETRIES = 5
RETRY_BACKOFF_SECONDS = 2.0

log = logging.getLogger("smugmug_crawl")


# ---------------------------------------------------------------------------
# API client
# ---------------------------------------------------------------------------

@dataclass
class SmugMugClient:
    """Minimal SmugMug API v2 client: OAuth 1.0a, pagination, retry-on-429."""

    api_key: str
    api_secret: str
    access_token: str
    access_token_secret: str
    session: requests.Session = field(default_factory=requests.Session)

    def __post_init__(self) -> None:
        self.session.auth = OAuth1(
            self.api_key,
            client_secret=self.api_secret,
            resource_owner_key=self.access_token,
            resource_owner_secret=self.access_token_secret,
            signature_type="auth_header",
        )
        self.session.headers.update({"Accept": "application/json"})

    def get(self, path: str, params: dict | None = None) -> dict:
        """GET a SmugMug API path (absolute URL or `/api/v2/...` relative).

        Retries with exponential backoff on 429 (honoring Retry-After) and
        on 5xx responses. Raises for other non-2xx statuses.
        """
        url = path if path.startswith("http") else f"{API_BASE}{path}"
        attempt = 0
        while True:
            attempt += 1
            response = self.session.get(url, params=params, timeout=30)

            if response.status_code == 200:
                return response.json()

            if response.status_code == 429:
                retry_after = float(
                    response.headers.get("Retry-After", RETRY_BACKOFF_SECONDS * attempt)
                )
                log.warning("429 rate-limited; sleeping %.1fs (attempt %d)", retry_after, attempt)
                time.sleep(retry_after)
                continue

            if 500 <= response.status_code < 600 and attempt < MAX_RETRIES:
                sleep = RETRY_BACKOFF_SECONDS * (2 ** (attempt - 1))
                log.warning(
                    "HTTP %d on %s; retrying in %.1fs (attempt %d)",
                    response.status_code, url, sleep, attempt,
                )
                time.sleep(sleep)
                continue

            response.raise_for_status()

    def paginate(self, path: str, params: dict | None = None) -> Iterator[dict]:
        """Yield each page of a SmugMug HAL collection.

        SmugMug returns pagination as `Response.Pages.NextPage`, a relative
        URI with start/count baked in. Params are only sent on the first
        request — subsequent NextPage URIs already include them.
        """
        params = {"count": PAGE_SIZE, **(params or {})}
        next_path: str | None = path
        first = True
        while next_path:
            page = self.get(next_path, params=params if first else None)
            yield page
            first = False
            next_path = (
                page.get("Response", {}).get("Pages", {}).get("NextPage")
            )


# ---------------------------------------------------------------------------
# Projection: raw SmugMug JSON → manifest entries
# ---------------------------------------------------------------------------

def _split_keywords(raw: Any) -> list[str]:
    """Normalize SmugMug keywords to a clean list.

    Inconsistent across resources: Nodes return a list, Images return a
    semicolon-delimited string. Accept either; drop empties.
    """
    if not raw:
        return []
    if isinstance(raw, list):
        return [str(k).strip() for k in raw if str(k).strip()]
    return [k.strip() for k in str(raw).split(";") if k.strip()]


def _node_entry(node: dict[str, Any], path: list[str]) -> dict[str, Any]:
    """Project a raw SmugMug Node into the manifest's folder/album entry shape."""
    return {
        "type": node["Type"].lower(),
        "node_id": node["NodeID"],
        "name": node.get("Name", ""),
        "url_name": node.get("UrlName", ""),
        "url_path": node.get("UrlPath", ""),
        "path": path,
        "description": node.get("Description", "") or "",
        "keywords": _split_keywords(node.get("Keywords")),
        "date_added": node.get("DateAdded"),
        "privacy": node.get("Privacy", "Unknown"),
        "security_type": node.get("SecurityType", "None"),
        "password": node.get("Password") or None,
        "password_hint": node.get("PasswordHint") or None,
    }


def _image_entry(image: dict[str, Any]) -> dict[str, Any] | None:
    """Project a SmugMug AlbumImage into the manifest's image entry shape.

    Returns None for video assets so the caller can count + skip.
    """
    if image.get("IsVideo"):
        return None
    return {
        "image_key": image["ImageKey"],
        "filename": image.get("FileName", ""),
        "caption": image.get("Caption", "") or "",
        "keywords": _split_keywords(image.get("Keywords")),
        "archived_uri": image.get("ArchivedUri"),
        "archived_md5": image.get("ArchivedMD5"),
        "archived_size": image.get("ArchivedSize"),
        "date": image.get("Date"),
        "format": image.get("Format"),
    }


# ---------------------------------------------------------------------------
# Tree walk
# ---------------------------------------------------------------------------

def walk_tree(client: SmugMugClient, root_node_uri: str) -> Iterator[dict[str, Any]]:
    """Depth-first walk of the SmugMug node tree.

    Yields manifest entries (folder or album dicts). Folders are emitted
    before their descendants so the manifest preserves on-site order.
    """
    state: dict[str, int] = {"skipped_videos": 0}
    yield from _walk(client, root_node_uri, [], state)
    if state["skipped_videos"]:
        log.info("Skipped %d video assets across all albums", state["skipped_videos"])


def _walk(
    client: SmugMugClient,
    node_uri: str,
    path: list[str],
    state: dict[str, int],
) -> Iterator[dict[str, Any]]:
    children_uri = f"{node_uri}!children"
    for page in client.paginate(children_uri):
        for child in page.get("Response", {}).get("Node", []) or []:
            node_type = child.get("Type")

            if node_type == "Folder":
                entry = _node_entry(child, path + [child.get("Name", "")])
                log.info("Folder: %s [%s]", entry["url_path"], entry["privacy"])
                yield entry
                yield from _walk(client, child["Uri"], entry["path"], state)

            elif node_type == "Album":
                entry = _node_entry(child, path + [child.get("Name", "")])
                album = _resolve_album(client, child)
                entry["album_key"] = album.get("AlbumKey")
                entry["sort_method"] = album.get("SortMethod")
                entry["image_count"] = album.get("ImageCount", 0)
                entry["images"] = []

                album_uri = album.get("Uri") or child.get("Uris", {}).get("Album", {}).get("Uri")
                if album_uri:
                    for raw_image in _iter_album_images(client, album_uri):
                        projected = _image_entry(raw_image)
                        if projected is None:
                            state["skipped_videos"] += 1
                            continue
                        entry["images"].append(projected)

                log.info(
                    "Album:  %s [%s, %d images]",
                    entry["url_path"], entry["privacy"], len(entry["images"]),
                )
                yield entry

            else:
                log.debug(
                    "Skipping node type=%s name=%s", node_type, child.get("Name"),
                )


def _resolve_album(client: SmugMugClient, album_node: dict[str, Any]) -> dict[str, Any]:
    """Fetch the underlying Album resource for an Album-type Node."""
    album_uri = album_node.get("Uris", {}).get("Album", {}).get("Uri")
    if not album_uri:
        return {}
    body = client.get(album_uri)
    return body.get("Response", {}).get("Album", {})


def _iter_album_images(client: SmugMugClient, album_uri: str) -> Iterator[dict[str, Any]]:
    images_uri = f"{album_uri}!images"
    for page in client.paginate(images_uri):
        for image in page.get("Response", {}).get("AlbumImage", []) or []:
            yield image


# ---------------------------------------------------------------------------
# Entry point
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
            + "\n\nObtain credentials at https://api.smugmug.com/api/developer/apply\n"
            "then export the four tokens before re-running this script."
        )
    return tuple(os.environ[name] for name in REQUIRED_ENV)  # type: ignore[return-value]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Pass 1: walk a SmugMug account and emit manifest.json.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="OAuth tokens are read from the environment (see module docstring).",
    )
    parser.add_argument(
        "--nickname",
        required=True,
        help="SmugMug nickname (the URL slug at smugmug.com/<nickname>).",
    )
    parser.add_argument(
        "--output",
        default=Path("manifest.json"),
        type=Path,
        help="Path to write the manifest JSON (default: manifest.json).",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable debug-level logging (per-request).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    api_key, api_secret, access_token, access_token_secret = load_credentials()
    client = SmugMugClient(api_key, api_secret, access_token, access_token_secret)

    log.info("Resolving root node for nickname=%s", args.nickname)
    user_body = client.get(f"/api/v2/user/{args.nickname}")
    user = user_body.get("Response", {}).get("User", {})
    root_node_uri = user.get("Uris", {}).get("Node", {}).get("Uri")
    if not root_node_uri:
        sys.exit(
            f"Could not resolve root node for nickname {args.nickname!r}. "
            "Check the nickname spelling and that your access token is "
            "authorized for this account."
        )

    nodes: list[dict[str, Any]] = list(walk_tree(client, root_node_uri))

    folder_count = sum(1 for n in nodes if n["type"] == "folder")
    album_count = sum(1 for n in nodes if n["type"] == "album")
    image_count = sum(len(n.get("images", [])) for n in nodes if n["type"] == "album")

    manifest = {
        "smugmug_nickname": args.nickname,
        "crawled_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "folder_count": folder_count,
        "album_count": album_count,
        "image_count": image_count,
        "nodes": nodes,
    }

    args.output.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    log.info(
        "Wrote %s — %d folders, %d albums, %d images",
        args.output, folder_count, album_count, image_count,
    )


if __name__ == "__main__":
    main()
