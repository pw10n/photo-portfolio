# photo-portfolio

Tooling for a static photo gallery site hosted on Cloudflare Pages + R2.

This repo holds **only the tooling** — Astro project, build scripts, configs. Photo originals and per-album metadata live in a separate local-only **content repo** (see [Content repo layout](#content-repo-layout)), referenced from a gitignored `.config.yaml`.

---

## Overview

```
┌─────────────────────────────┐
│ Content repo (local-only)   │
│   <folder>/<album>/         │
│     meta.yaml               │
│     *.jpg                   │
└──────────────┬──────────────┘
               │  yaml_to_content.mjs
               │  process_images.mjs
               ▼
┌─────────────────────────────┐
│ This repo (photo-portfolio) │
│   src/content/   (generated)│
│   build/         (cached)   │
│   dist/          (built)    │
└──────────────┬──────────────┘
               │  publish.mjs
               ▼
┌──────────────────┐  ┌────────────────────────┐
│ Cloudflare Pages │  │ Cloudflare R2          │
│ gallery.…        │  │ assets.…               │
└──────────────────┘  └────────────────────────┘
```

- **Astro** generates the site. Content collections are typed; lightbox + password gate are interactive islands.
- **sharp** encodes responsive AVIF/WebP/JPEG derivatives + 200×200 thumbnails at widths 480/960/1600/2400.
- **R2** serves all image bytes (derivatives + originals) from `assets.example.com`.

---

## Prerequisites

- Node 20+ (for Astro + sharp)
- Python 3.11+ (only for the few utility scripts in `scripts/`)
- A Cloudflare account with:
  - A Pages project (`photo-portfolio`)
  - An R2 bucket bound to `assets.example.com`
  - An API token with `Pages:Edit` + `Account:Read`
  - An R2 access key pair

---

## Setup

```bash
git clone <repo-url> photo-portfolio
cd photo-portfolio
npm install

cp .config.example.yaml .config.yaml
$EDITOR .config.yaml      # set content_root: <absolute path to your content repo>

cp .env.example .env
$EDITOR .env              # set CLOUDFLARE_API_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
```

`.config.yaml` and `.env` are gitignored. Never commit them.

Verify setup:

```bash
npm run build            # full build into dist/; does not publish
```

---

## Content repo layout

The content repo is the **canonical source of truth** for galleries. Edit YAML, drop in photos, rebuild.

```
<content_root>/
├── .legacy-keys.json              # auto-maintained; preserves legacy-site deep links
├── Travel/
│   ├── meta.yaml                  # folder
│   └── Iceland-Ring-Road/
│       ├── meta.yaml              # album
│       ├── 306B2755.jpg           # original (any of .jpg/.jpeg/.png)
│       └── 306B2756.jpg
└── Weddings/
    ├── meta.yaml
    └── Sample-Wedding/
        ├── meta.yaml
        └── ...
```

- **Directory path is the URL.** `<content_root>/Travel/Iceland-Ring-Road/` → `/Travel/Iceland-Ring-Road` on the live site.
- **Image files are auto-discovered.** Anything matching `.jpg|.jpeg|.png` (case-insensitive) in an album directory is included.
- **Captions + keywords are read from embedded IPTC/XMP** (the metadata written into the file). YAML overrides only when needed.
- **Plaintext passwords live in the content repo and never leave it** — they're hashed (sha256 + per-album salt) during the build before reaching `dist/` or R2.

---

## Adding a new album

### 1. Create the directory and drop photos in

```bash
mkdir -p "$CONTENT_ROOT/Travel/Joshua-Tree-Spring"
cp ~/exports/joshua-tree/*.jpg "$CONTENT_ROOT/Travel/Joshua-Tree-Spring/"
```

The parent folder (`Travel/`) must already exist with its own `meta.yaml`.

### 2. Write a minimal `meta.yaml`

```yaml
# <content_root>/Travel/Joshua-Tree-Spring/meta.yaml
name: "Joshua Tree Spring"
date: 2026-06-15
```

That's the minimum. Defaults kick in for `privacy`, `security_type`, `sort`, etc.

You **don't** write:
- `url_name` — derived from the directory name
- `id:` — auto-stamped on the first build (and written back into this file)
- `images:` — auto-discovered from the directory
- Per-image captions / keywords if your photos already carry them in IPTC/XMP

### 3. Build and publish

```bash
npm run deploy
```

This runs the full chain: ingest YAML → encode derivatives → render site → sync R2 → deploy Pages.

After the build, open `meta.yaml` again and you'll see a new line:

```yaml
id: alb_h3k9m2qx        # ← auto-stamped, leave it alone
```

This is the album's permanent identifier — it survives directory renames and keeps every photo's R2 keys + share URLs stable.

---

## Other common workflows

### Add a new folder

```bash
mkdir -p "$CONTENT_ROOT/Events"
cat > "$CONTENT_ROOT/Events/meta.yaml" <<EOF
name: "Events"
EOF
```

Then add albums inside it.

### Replace a photo with a new version

Drop the new file in over the old one (same filename). Rebuild.

```bash
cp ~/exports/joshua-tree/IMG_4501.jpg "$CONTENT_ROOT/Travel/Joshua-Tree-Spring/"
npm run deploy
```

The `image_id` is derived from `album.id + filename`, so it doesn't change — share URLs survive, only the changed file gets re-encoded.

### Rename an album

```bash
mv "$CONTENT_ROOT/Travel/Joshua-Tree-Spring" "$CONTENT_ROOT/Travel/Joshua-Tree-2026"
npm run deploy
```

The URL changes (`/Travel/Joshua-Tree-2026`) but `album.id` lives in the YAML, so all `image_id` values are unchanged — no R2 churn.

If you want the old URL to keep working, add a one-line entry to `public/_redirects`:

```
/Travel/Joshua-Tree-Spring/*  /Travel/Joshua-Tree-2026/:splat  301
```

### Password-protect an album

```yaml
name: "Sample Wedding"
date: 2024-06-22
security_type: password
password: "summer2024"          # plaintext — local-only, never reaches dist/ or R2
password_hint: "season + year"
```

Rebuild. The plaintext is hashed (sha256 + per-album salt) at build time. Visitors must enter the password before content loads.

### Mark an album unlisted

```yaml
privacy: unlisted               # hides from indexes; URL still works for anyone with the link
```

### Override caption / keywords for one photo

Use this only when the photo's embedded IPTC/XMP doesn't carry what you want.

```yaml
images:
  IMG_4501.jpg:
    caption: "Sunset over the vineyard"
    keywords: [sunset, vineyard]
```

To explicitly clear keywords from one photo (overriding embedded metadata):

```yaml
images:
  IMG_4501.jpg:
    keywords: []
```

### Set a custom hero image

```yaml
hero: IMG_4502.jpg              # default is the first image
```

### Change image ordering

```yaml
sort: date                      # filename | date | manual
```

`manual` sort respects the order in which filenames appear under `images:` in YAML, falling back to filename for any image not listed.

---

## `meta.yaml` reference

### Album

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | string | required | Display name |
| `date` | YYYY-MM-DD | required | Event date |
| `url_name` | string | derived | Path segment; defaults to directory name |
| `id` | string | auto-stamped | Don't write by hand |
| `description` | string | `""` | Long-form, shown on album page |
| `keywords` | string[] | `[]` | Album-level keywords |
| `privacy` | `public` \| `unlisted` | `public` | |
| `security_type` | `none` \| `password` | `none` | |
| `password` | string | `null` | Plaintext, local-only |
| `password_hint` | string | `null` | Shown above password input |
| `sort` | `filename` \| `date` \| `manual` | `filename` | |
| `hero` | filename | first image | |
| `images` | map | `{}` | Sparse per-image overrides |

### Folder

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | string | required | Display name |
| `url_name` | string | derived | Path segment; defaults to directory name |
| `description` | string | `""` | Shown on folder page |
| `privacy` | `public` \| `unlisted` | `public` | |

---

## Build & publish

| Command | What it does |
|---|---|
| `npm run build` | YAML → content collections → encode derivatives → `astro build` → invariant checks |
| `npm run publish` | Sync R2 deltas → `wrangler pages deploy dist/` |
| `npm run deploy` | `build` then `publish` |

Re-runs are idempotent. The derivative cache short-circuits on unchanged source files; R2 sync skips unchanged objects.

If a build invariant fails (e.g. missing password for a protected album, duplicate album `id:`, plaintext password leaked into `src/content/`), the chain halts with a non-zero exit. **Fix the root cause** — don't bypass.

---

## URL contract

The site preserves URL patterns from the legacy site so external inbound links survive:

- Folder page: `/<folder>`
- Album page: `/<folder>/<album>` (up to 4 levels deep)
- Image deep link: `/<folder>/<album>/i-<id>` — opens the lightbox on the keyed image. Both native `image_id` values (11-char lowercase base32) and legacy site keys are accepted; the lightbox resolves them transparently.
- Legacy size suffixes (`/X3`, `/A`, etc.) on image URLs are accepted and ignored.

Native share URLs from the lightbox always use `image_id`. Legacy keys are resolved via `<content_root>/.legacy-keys.json` (auto-maintained).

---

## Project layout

```
photo-portfolio/
├── .config.yaml              # gitignored; { content_root: <absolute path> }
├── .config.example.yaml      # committed; documents the shape
├── .env                      # gitignored; CF tokens
├── astro.config.mjs
├── package.json
├── public/
│   └── _redirects            # Pages routing rules
├── src/
│   ├── content/              # gitignored; regenerated each build
│   ├── components/           # Astro + island components
│   ├── layouts/
│   ├── lib/
│   ├── pages/
│   └── styles/
├── scripts/
│   ├── yaml_to_content.mjs   # ingest content repo → src/content/
│   ├── process_images.mjs    # encode derivatives
│   ├── build.mjs             # invoked by `npm run build`
│   ├── publish.mjs           # invoked by `npm run publish`
│   └── verify.mjs            # build invariants
└── build/                    # gitignored; derivative cache, image metadata, upload cache
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Error: content_root does not exist` | Check the path in `.config.yaml` |
| `Build halted: album <slug> has security_type=password but no password` | Add a `password:` to that album's `meta.yaml` |
| `Build halted: duplicate album id` | Two albums share the same `id:`. Rare. Delete the duplicated `id:` line from one of them and rebuild — it'll get a fresh stamp. |
| Photos look sideways | The pipeline respects EXIF orientation. If a single photo is wrong, fix its orientation tag (e.g. `exiftool -Orientation=1 -n file.jpg`) and rebuild. |
| Album shows but photos are missing | Check `build/image-meta.json` for the album's `image_id` entries; rerun `npm run build` to repopulate the derivative cache. |
| R2 upload partial-fails | Rerun `npm run publish` — the upload cache resumes from where it left off. |
