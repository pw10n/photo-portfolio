// Catch-all Cloudflare Pages Function: intercepts every request.
//
// Photo URLs (/album/path/i-KEY or /album/path/i-KEY/SIZE) have no static
// file, so we rewrite them to their album page — the lightbox reads the URL
// on mount and opens the correct photo.
//
// All other requests (homepage, album/folder pages, assets) are forwarded to
// env.ASSETS.fetch(), which reads directly from the Pages KV store.

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '');

  // Match /album/path/i-KEY or /album/path/i-KEY/SIZE_SUFFIX
  // KEY is alphanumeric (native: 11-char base32; legacy: SmugMug key)
  const photoMatch = pathname.match(/^(.*?)\/i-[A-Za-z0-9]+(?:\/[A-Za-z0-9]+)?$/);
  if (!photoMatch) {
    return env.ASSETS.fetch(request);
  }

  const albumPath = photoMatch[1] || '/';

  // Fetch the album page — trailing slash resolves the directory index
  const albumUrl = new URL(request.url);
  albumUrl.pathname = albumPath.endsWith('/') ? albumPath : albumPath + '/';

  return env.ASSETS.fetch(albumUrl.toString());
}
