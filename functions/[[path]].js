// Intercept photo URLs (/album/path/i-imageId) and serve the album page.
//
// Cloudflare Pages runs this function only for URLs that don't match a static
// file, so album/folder pages are served directly with no overhead. Photo URLs
// (/i-KEY or /i-KEY/SIZE_SUFFIX) have no static files, so they land here.
//
// env.ASSETS.fetch() reads directly from the Pages KV store, bypassing any
// redirect rules, so the album's index.html is returned without a round-trip.
// The browser URL stays as the photo URL — the lightbox reads it on mount and
// opens the correct photo.

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '');

  // Match /album/path/i-KEY or /album/path/i-KEY/SIZE_SUFFIX
  // KEY is alphanumeric (native: 11-char base32; legacy: SmugMug key)
  const photoMatch = pathname.match(/^(.*?)\/i-[A-Za-z0-9]+(?:\/[A-Za-z0-9]+)?$/);
  if (!photoMatch) {
    return new Response('Not found', { status: 404 });
  }

  const albumPath = photoMatch[1] || '/';

  // Fetch the album page — trailing slash resolves the directory index
  const albumUrl = new URL(request.url);
  albumUrl.pathname = albumPath.endsWith('/') ? albumPath : albumPath + '/';

  return env.ASSETS.fetch(albumUrl.toString());
}
