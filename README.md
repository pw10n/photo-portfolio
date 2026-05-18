# photo-portfolio

Tooling for a static photo gallery site hosted on Cloudflare Pages + R2.

This repo holds **only the tooling** — Astro project, build scripts, configs. Photo originals and per-album metadata live in a separate local-only **content repo** (see [Content repo layout](#content-repo-layout)), referenced from a gitignored `.config.yaml`.

---

## Overview

```
┌──────────────────────────────────────┐
│ content_root (local / NFS / etc.)    │
│   ├── content/                       │
│   │     <folder>/<album>/            │
│   │       meta.yaml                  │
│   │       *.jpg                      │
│   └── build/         (auto-created)  │
│         derivatives/                 │
│         image-meta.json              │
│         derivative-cache.json        │
│         legacy-keys.json             │
└──────────────────┬───────────────────┘
                   │  yaml_to_content.mjs
                   │  process_images.mjs
                   ▼
┌─────────────────────────────┐
│ This repo (photo-portfolio) │
│   src/content/   (generated)│
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
- **R2** serves all image bytes (derivatives + originals) from `assets.prenticew.com` in production. For local dev, derivatives are served by the Astro dev server via a `public/derivatives → <content_root>/build/derivatives` symlink.

---

## Prerequisites

- Node 20+ (for Astro + sharp)
- Python 3.11+ (only for the SmugMug helper scripts; not needed for local dev)
- For production deploy only: a Cloudflare account with Pages + R2 + API token + R2 access key pair

For local development, none of the Cloudflare bits are required.

---

## Setup

```bash
git clone <repo-url> photo-portfolio
cd photo-portfolio
npm install

# Point at your portfolio directory
cp .config.example.yaml .config.yaml
$EDITOR .config.yaml      # set content_root: <absolute path>

# Create site-wide config under content_root (site_url, name, etc.)
cp .site.example.yaml "$(yq .content_root .config.yaml | tr -d '"')/site.yaml"
$EDITOR "$(yq .content_root .config.yaml | tr -d '"')/site.yaml"
```

`.config.yaml` and `.env` are gitignored. `<content_root>/site.yaml` lives outside the repo so the tooling is reusable across portfolios — never commit it to this repo either.

---

## Local development with test content

The fastest way to see the site work end-to-end against fake but real photos:

```bash
# 1. Generate procedural test JPEGs + site.yaml into ./test-content/
node scripts/seed_test_content.mjs

# 2. Point .config.yaml at the fixture
echo "content_root: $(pwd)/test-content" > .config.yaml

# 3. Build + serve. `npm run dev` and `npm run build:local` auto-create the
#    public/derivatives symlink and load <content_root>/site.local.yaml
#    (or apply built-in localhost defaults if it's absent).
npm run dev                      # http://localhost:4321 with HMR
# …or for a static preview:
npm run build:local
npm run preview                  # http://localhost:4321
```

After this, edit any photo, `meta.yaml`, or component and re-run `npm run build` (or rely on HMR for component edits). Drop your own JPEGs into `test-content/Sample/Sunset-Hike/` and they'll be auto-discovered.

To switch to your real content repo later, just change `content_root` in `.config.yaml` — same scripts, same commands.

---

## Deploy to Cloudflare

The site deploys to **Cloudflare Pages** (HTML/CSS/JS) with images on **Cloudflare R2** (`assets.prenticew.com`). One-time setup, then `npm run deploy` is incremental — only changed images upload to R2.

### First-time setup

Wrangler and the upload script can't create their own credentials. There are exactly two manual dashboard steps; the rest is CLI.

**Step 1 — Cloudflare API token** (lets `wrangler` create the R2 bucket + Pages project + DNS records).

Dashboard → **My Profile → API Tokens → Create Token → Custom token**. Permissions:
- `Account → Cloudflare Pages → Edit`
- `Account → Workers R2 Storage → Edit`
- `Zone → DNS → Edit` (scope: `prenticew.com`)

```bash
cp .env.example .env
$EDITOR .env    # paste CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (from dashboard sidebar)
```

**Step 2 — Provision R2 + Pages** (idempotent; safe to re-run):

```bash
npm install                # picks up @aws-sdk/client-s3 and wrangler
npm run cf:setup           # creates R2 bucket, attaches assets.prenticew.com, creates Pages project
```

**Step 3 — R2 S3 access keys** (lets `publish.mjs` PUT images into the bucket).

Dashboard → **R2 → Manage R2 API Tokens → Create API token**.
Permission: **Object Read & Write**, scoped to the `photo-portfolio` bucket (now exists thanks to step 2).

```bash
$EDITOR .env    # paste AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
```

### Deploy

```bash
npm run deploy             # = npm run build && npm run publish
```

- `build` runs the local pipeline (ingest → encode derivatives → astro build → verify).
- `publish` walks `build/derivatives/` and the originals referenced by each album, sha256s each file, **skips anything already in `build/upload-cache.json`**, uploads the rest to R2, then runs `wrangler pages deploy dist/`.

Initial deploy uploads everything (~14k originals + ~210k derivatives) and takes 1–2 hours depending on uplink. Subsequent deploys, after adding a new album, only upload that album's images — typically seconds to minutes.

### Custom domain (after first deploy)

The first `wrangler pages deploy` creates a `*.pages.dev` URL. Attach the shadow hostname when ready to start parity-testing:

```bash
npx wrangler pages deployment domain add \
  --project-name=photo-portfolio sgallery.prenticew.com
```

Cut over to `gallery.prenticew.com` only after shadow parity is satisfactory (plan §9).

---

## Content repo layout

`content_root` is the **portfolio parent directory**, which has two subdirectories: `content/` (canonical source of truth — edit YAML, drop in photos, rebuild) and `build/` (auto-created, holds derivatives + caches; safe to delete to force a full re-encode).

```
<content_root>/
├── site.yaml                      # site-wide config (site_url, name, etc.)
├── content/
│   ├── .legacy-keys.json          # auto-maintained; preserves legacy-site deep links
│   ├── Travel/
│   │   ├── meta.yaml              # folder
│   │   └── Iceland-Ring-Road/
│   │       ├── meta.yaml          # album
│   │       ├── 306B2755.jpg       # original (any of .jpg/.jpeg/.png)
│   │       └── 306B2756.jpg
│   └── Weddings/
│       ├── meta.yaml
│       └── Sample-Wedding/
│           ├── meta.yaml
│           └── ...
└── build/                         # auto-created by process_images.mjs
    ├── derivatives/<image_id>/{480,960,1600,2400}.{avif,webp,jpg}, thumb.{...}
    ├── image-meta.json            # dims + projected EXIF per image_id
    ├── derivative-cache.json      # image_id → source sha256 (skip-unchanged)
    └── legacy-keys.json           # mirrored from content/.legacy-keys.json
```

- **Directory path is the URL.** `<content_root>/Travel/Iceland-Ring-Road/` → `/Travel/Iceland-Ring-Road` on the live site.
- **Image files are auto-discovered.** Anything matching `.jpg|.jpeg|.png` (case-insensitive) in an album directory is included.
- **Captions + keywords are read from embedded IPTC/XMP** (the metadata written into the file). YAML overrides only when needed.
- **Plaintext passwords live in the content repo and never leave it** — they're hashed (sha256 + per-album salt) during the build before reaching `dist/` or R2.

---

## Adding a new album

### 1. Create the directory and drop photos in

```bash
mkdir -p "$CONTENT_ROOT/content/Travel/Joshua-Tree-Spring"
cp ~/exports/joshua-tree/*.jpg "$CONTENT_ROOT/content/Travel/Joshua-Tree-Spring/"
```

The parent folder (`content/Travel/`) must already exist with its own `meta.yaml`.

### 2. Write a minimal `meta.yaml`

```yaml
# <content_root>/content/Travel/Joshua-Tree-Spring/meta.yaml
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
npm run deploy     # build + upload changed images to R2 + deploy Pages
```

This runs the full chain: ingest YAML → encode derivatives → render site → verify invariants → delta-upload to R2 (only changed/new images) → `wrangler pages deploy`. Use `npm run build` alone if you want to render the site without publishing.

After the build, open `meta.yaml` again and you'll see a new line:

```yaml
id: alb_h3k9m2qx        # ← auto-stamped, leave it alone
```

This is the album's permanent identifier — it survives directory renames and keeps every photo's R2 keys + share URLs stable.

---

## Other common workflows

### Add a new folder

```bash
mkdir -p "$CONTENT_ROOT/content/Events"
cat > "$CONTENT_ROOT/content/Events/meta.yaml" <<EOF
name: "Events"
EOF
```

Then add albums inside it.

### Replace a photo with a new version

Drop the new file in over the old one (same filename). Rebuild.

```bash
cp ~/exports/joshua-tree/IMG_4501.jpg "$CONTENT_ROOT/content/Travel/Joshua-Tree-Spring/"
npm run build      # `npm run deploy` will replace this once publish.mjs lands
```

The `image_id` is derived from `album.id + filename`, so it doesn't change — share URLs survive, only the changed file gets re-encoded.

### Rename an album

```bash
mv "$CONTENT_ROOT/content/Travel/Joshua-Tree-Spring" "$CONTENT_ROOT/content/Travel/Joshua-Tree-2026"
npm run build      # `npm run deploy` will replace this once publish.mjs lands
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

### Set a custom listing thumbnail

```yaml
hero: IMG_4502.jpg              # which image represents the album in folder/home grids (default: first image)
```

The `hero` field controls which image is used as the album's thumbnail in folder pages and the homepage "Recently Added" grid. It is not rendered on the album page itself.

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

| Command | What it does | Status |
|---|---|---|
| `npm run build` | Production: `yaml_to_content` → `process_images` → `astro build` → `verify`. Uses bare `site.yaml`. | ✓ works |
| `npm run build:local` | Same chain but with `PROFILE=local` (localhost URLs, public/derivatives symlink). | ✓ works |
| `npm run dev` | Auto-sets up symlinks + runs Astro dev server with HMR on `PROFILE=local`. | ✓ works |
| `npm run preview` | Serves the last-built `dist/`. | ✓ works |
| `npm run setup:local` | Idempotent: creates the `public/derivatives` symlink and a `site.local.yaml` stub if absent. | ✓ works |
| `npm run publish` | Sync R2 deltas → `wrangler pages deploy dist/` | ⏳ not yet implemented |
| `npm run deploy` | `build` then `publish` | ⏳ blocked on `publish` |

Re-runs are idempotent. The derivative cache (`build/derivative-cache.json`) short-circuits on unchanged source files via sha256.

If a build invariant fails (e.g. missing password for a protected album, duplicate album `id:`, plaintext password leaked into `src/content/`), the chain halts with a non-zero exit. **Fix the root cause** — don't bypass.

### Verify (build invariants)

`scripts/verify.mjs` runs 10 checks per TDD §14:

1. Every album `url_path` has a matching `dist/<path>/index.html`
2. Every folder `url_path` has a matching HTML page
3. Every image has at least one derivative at width 960 (or the largest available width if smaller)
4. No `/private/` paths in `dist/index.html` or any `sitemap-*.xml`
5. Every password-protected album has a 64-char hex hash + salt; no plaintext password appears anywhere under `src/content/` or `dist/`
6. `dist/_redirects` contains both legacy-key rewrite rules
7. Random sample of 20 derivatives: actual width never exceeds source intrinsic
8. Every `.legacy-keys.json` entry resolves to an existing album + filename
9. Every album has an `id:` matching `^alb_[A-Za-z0-9]+$`, no duplicates
10. Native `image_id` namespace and legacy SmugMug key namespace don't overlap

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
├── .config.yaml                # gitignored; { content_root: <absolute path> }
├── .config.example.yaml        # committed; documents the shape
├── .env                        # gitignored; PUBLIC_ASSETS_BASE_URL, CF tokens
├── astro.config.mjs
├── tsconfig.json
├── package.json
├── public/
│   ├── _redirects              # Pages routing rules (legacy-key rewrites)
│   └── derivatives → <content_root>/build/derivatives   # local-dev symlink (gitignored)
├── src/
│   ├── content/
│   │   ├── config.ts           # Zod schemas (album, folder, albumImage)
│   │   ├── albums/             # gitignored; generated each build
│   │   └── folders/            # gitignored; generated each build
│   ├── components/
│   │   ├── BaseLayout (in layouts/)
│   │   ├── HomePage.astro
│   │   ├── FolderPage.astro
│   │   ├── AlbumPage.astro
│   │   ├── ResponsivePicture.astro
│   │   ├── Thumbnail.astro
│   │   ├── Breadcrumbs.astro
│   │   ├── Lightbox.tsx        # React island
│   │   └── PasswordGate.tsx    # React island
│   ├── layouts/
│   │   └── BaseLayout.astro
│   ├── lib/
│   │   ├── asset-urls.ts       # R2 / local URL builders
│   │   ├── image-meta.ts       # loads build/image-meta.json
│   │   ├── legacy-keys.ts      # loads build/legacy-keys.json + per-album slice
│   │   ├── password.ts         # Web Crypto sha256+salt verify
│   │   └── url-state.ts        # pathname ⇄ { album, key }
│   ├── pages/
│   │   ├── index.astro         # → HomePage
│   │   └── [...slug].astro     # → FolderPage | AlbumPage
│   └── styles/
│       └── global.css
├── scripts/
│   ├── seed_test_content.mjs   # generate procedural test-content/ (local dev only)
│   ├── yaml_to_content.mjs     # walk content_root → src/content/*.json
│   ├── process_images.mjs      # sharp → build/derivatives/ + image-meta.json
│   ├── build.mjs               # orchestrator invoked by `npm run build`
│   ├── verify.mjs              # 10 build invariants
│   ├── publish.mjs             # R2 sync + wrangler pages deploy (not yet implemented)
│   ├── manifest_to_yaml.mjs    # one-time SmugMug → content_root migration (not yet implemented)
│   ├── smugmug_*.py            # legacy SmugMug crawl/download/auth helpers
│   └── requirements.txt
└── (no build/ in this repo — build artifacts live under <content_root>/build/)
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Error: content_root does not exist` | Check the path in `.config.yaml`. For local dev, point it at `./test-content/` and run `node scripts/seed_test_content.mjs`. |
| `Build halted: album <slug> has security_type=password but no password` | Add a `password:` to that album's `meta.yaml`. |
| `verify: duplicate album id` | Two albums share the same `id:`. Rare. Delete the duplicated `id:` line from one of them and rebuild — it'll get a fresh stamp. |
| `verify: plaintext password leaked into …` | A `password:` value from `meta.yaml` ended up in generated content. Should never happen — file a bug; in the meantime, inspect the offending file and remove. |
| Photos look sideways | The pipeline respects EXIF orientation. If a single photo is wrong, fix its orientation tag (e.g. `exiftool -Orientation=1 -n file.jpg`) and rebuild. |
| Album shows but photos are missing | Check `build/image-meta.json` for the album's `image_id` entries; rerun `npm run build` to repopulate the derivative cache. |
| `Expected …/content to exist` | Photos must live under `<content_root>/content/`, not directly under `<content_root>/`. If you have an older layout, `mkdir <content_root>/content && mv <content_root>/<folders> <content_root>/content/`. |
| Photos 404 in local dev | Confirm `public/derivatives` symlinks to `<content_root>/build/derivatives` and `PUBLIC_ASSETS_BASE_URL=/` is set in `.env`. |
| R2 upload partial-fails | (Phase 1: `publish.mjs` not yet implemented.) When it lands: rerun `npm run publish` — the upload cache resumes from where it left off. |
