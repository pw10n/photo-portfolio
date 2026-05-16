# Product Requirements Document: Photo Gallery Website

## Overview
A statically-generated photo gallery application designed to replicate and modernize the core functionalities of `gallery.prenticew.com` using a Static Site Generator (SSG) architecture. The goal is to provide a sleek, performant, secure, and feature-rich platform for organizing, displaying, sharing, and selling photography, while minimizing hosting costs and operational overhead.

## 1. Core Navigation & Structure
*   **Homepage**
    *   Hero section with photographer branding, logo, and high-quality background imagery.
    *   Dynamic "Recently Added" grid displaying newly uploaded galleries with thumbnail previews.
*   **Navigation**
    *   Top-level menu with links to Home, Browse (category view), and Search.
    *   Breadcrumb navigation on subpages (e.g., `Home > Category > Album`) to orient the user.
*   **Organization**
    *   Nested hierarchy supporting multiple levels: Folders -> Galleries -> Photos.
    *   Privacy controls allowing specific galleries to be password-protected or entirely private (indicated by lock icons).
*   **URL Preservation (SmugMug Compatibility)**
    *   To avoid breaking external links, the site preserves the existing SmugMug URL structure for folders, galleries, and individual photos:
        *   Folder page: `/<folder>` (matches each folder's `UrlPath` in the migration manifest).
        *   Album page: `/<folder>/<album>` (up to 4 levels deep — the current catalog's max).
        *   Image deep link: `/<folder>/<album>/i-<image_key>`, opening the lightbox on that exact image.
        *   SmugMug size suffixes (`/A`, `/L`, `/M`, `/X2`, `/X3`, etc.) on image URLs are accepted and ignored.
    *   Implementation: a Cloudflare Pages `_redirects` rule rewrites `/*/i-:key` and `/*/i-:key/*` to the album HTML with HTTP 200 (rewrite, not redirect). Client JS reads `location.pathname` to position the lightbox. This avoids generating per-image HTML stubs.
    *   Out of scope for v1: bare short links (`/i-<key>` and `/n-<NodeID>`). These are rarely shared externally and Cloudflare Pages `_redirects` cannot scale to ~14k entries. Revisit only if real broken inbound links surface post-cutover (would require a Worker + build-time lookup index).

## 2. Photo Viewing & Interaction
*   **Gallery Grid**
    *   Responsive thumbnail grid layout for each gallery, featuring a larger hero image representing the album.
*   **Lightbox Viewer**
    *   Immersive, full-screen photo viewing experience accessible by clicking any thumbnail.
    *   Intuitive image navigation (previous/next via on-screen buttons, keyboard arrows, or swipe gestures on mobile).
    *   **Metadata Display**: An "Info" toggle revealing technical EXIF data (Camera Body, Lens, Aperture, ISO, Shutter Speed, Focal Length).

## 3. E-commerce & Monetization
*   **Purchase Flow**
    *   Prominent "Buy Photos" call-to-action (CTA) available at both the gallery level and individual photo lightbox level.
*   **Digital Products**
    *   Digital downloads with distinct licensing options (e.g., Personal Use vs. Commercial Use) at original or web resolution.
*   **Cart & Checkout**
    *   Integrated static-friendly shopping cart (e.g., Snipcart) or direct payment links (e.g., Stripe Payment Links) to manage multiple product types and variations.
    *   Secure serverless checkout flow supporting modern payment gateways without requiring a traditional backend.

## 4. Download & Sharing
*   **Downloads**
    *   "Download All" option for entire galleries (generating a zipped folder).
    *   Individual photo download buttons (respecting gallery permissions).
*   **Sharing**
    *   Integrated social sharing buttons for galleries and individual photos to platforms like Facebook, X (Twitter), Pinterest, and Email.
    *   Direct URL copy-to-clipboard functionality.
    *   Embed codes (HTML/BBCode) for blogging or forum usage.

## 5. Search & Discovery
*   **Global Search**
    *   Client-side or serverless search functionality (e.g., using Fuse.js, Lunr.js, or Algolia) accessible from the main navigation menu.
    *   Filtering system to categorize search results by Photos, Videos, Galleries, Folders, and Pages based on pre-built static indexes.

## 6. User Engagement & Footer
*   **Social & Contact**
    *   Footer linking to external social profiles (X, Flickr, personal blog).
    *   Secure Contact form connecting potential clients directly to the photographer.
*   **Legal/Compliance**
    *   Cookie consent banner (GDPR/CCPA compliant).
    *   Standard links to Terms of Service and Privacy Policy.
*   **Responsive Design**
    *   The entire application must be fully responsive, ensuring aesthetic and functional parity across desktop, tablet, and mobile devices.

## 7. Gallery Generation & Content Management (SSG Workflow)
*   **Content Architecture**
    *   Galleries and site structure managed via local file directories, Markdown, and configuration files (e.g., YAML/JSON frontmatter).
*   **Asset Processing Pipeline**
    *   Automated build scripts to process high-resolution images.
    *   Automatic generation of responsive image sizes, web-optimized formats (WebP/AVIF), and thumbnails during the build process.
*   **Deployment & Hosting**
    *   The repository is hosted locally (not on GitHub) due to the size of the photo source files, which exceeds the practical limits of remote Git hosting and Git LFS.
    *   Deployment is handled by local build and publish scripts orchestrated by **openclaw**, which runs the asset processing pipeline and pushes the resulting static site to Cloudflare Pages.
*   **Permissions & Commerce Settings**
    *   Control gallery visibility (Unlisted/Public) and pricing tiers through metadata configuration within the target folder. Checkouts and protection handled via static integrations or edge functions.

## 8. Technical Architecture (Zero/Low-Cost Cloudflare Stack)
This stack explicitly leverages generous free tiers to keep monthly operational costs to a minimum:

*   **Source Control & Build Orchestration (Local + openclaw)**
    *   Codebase, layout configurations, and high-resolution source photos live in a **local Git repository** rather than a remote host like GitHub, because the volume of original photo assets exceeds what is practical to push to a remote (and to Git LFS) and would incur unnecessary bandwidth and storage costs.
    *   **openclaw** orchestrates the build and deploy pipeline locally: it runs the site build whenever new content or updates land, executes the asset processing scripts (thumbnail generation, WebP/AVIF conversion), and then publishes the built artifacts to Cloudflare Pages. This replaces the role that GitHub Actions would normally play in a cloud-hosted setup.
*   **Hosting & Global CDN (Cloudflare Pages)**
    *   **Deployment**: The fully built static site (HTML, CSS, JS) is pushed directly to Cloudflare Pages.
    *   **Delivery**: CF Pages inherently provides global CDN caching, SSL certificates, and virtually unlimited bandwidth for free.
*   **Heavy Image Storage (Cloudflare R2)**
    *   Because high-resolution photo repositories often exceed the limits of standard Git LFS, original and high-res source photos should be stored in Cloudflare R2 object storage.
    *   R2 offers a generous 10GB/month free tier with zero egress fees, making it vastly more cost-effective than AWS S3 for a highly-trafficked photo gallery.
*   **Dynamic Functionality (Cloudflare Workers/Functions)**
    *   Tasks like authenticating passwords on private galleries, communicating with a lightweight database if needed (Cloudflare D1), or handling payment webhooks (Stripe/Snipcart integrations) can be managed via serverless Cloudflare Workers, keeping everything within the same ecosystem.
