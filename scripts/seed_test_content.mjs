#!/usr/bin/env node
// Generate a throwaway test-content/ tree with procedural JPEGs + meta.yaml.
// Drop your own JPEGs in afterward and they'll be picked up automatically.

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';

// Writes into <test-content-root>/content/ to match the layout convention:
//   <content_root>/
//   ├── content/   ← seeded here
//   └── build/     ← created by process_images on first build
const PORTFOLIO_ROOT = resolve(import.meta.dirname, '..', 'test-content');
const ROOT = resolve(PORTFOLIO_ROOT, 'content');

const FIXTURES = [
  {
    folder: { url_name: 'Sample', name: 'Sample' },
    albums: [
      {
        url_name: 'Sunset-Hike',
        name: 'Sunset Hike',
        date: '2026-05-12',
        description: 'Procedurally generated test album. Warm gradients only.',
        keywords: ['test', 'gradient', 'warm'],
        photos: 8,
        palette: ['#ff7a00', '#ff4d00', '#cc3300', '#992600'],
      },
      {
        url_name: 'Cold-Water',
        name: 'Cold Water',
        date: '2026-03-01',
        description: 'Procedurally generated test album. Cool gradients only.',
        keywords: ['test', 'gradient', 'cool'],
        photos: 5,
        palette: ['#0066cc', '#0099cc', '#004d99', '#003366'],
      },
    ],
  },
  {
    folder: { url_name: 'Studio', name: 'Studio' },
    albums: [
      {
        url_name: 'Solids',
        name: 'Solids',
        date: '2026-01-20',
        description: 'Single-color tiles for layout testing.',
        keywords: ['test'],
        photos: 4,
        palette: ['#1a1a1a', '#3a3a3a', '#5a5a5a', '#7a7a7a'],
      },
    ],
  },
];

const SIZES = [
  { w: 2400, h: 1600 },
  { w: 1600, h: 2400 },
  { w: 1800, h: 1800 },
  { w: 2400, h: 1350 },
];

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

async function makeGradientJpeg(outPath, color, label, size) {
  const { w, h } = size;
  const { r, g, b } = hexToRgb(color);
  const r2 = Math.max(0, r - 60);
  const g2 = Math.max(0, g - 60);
  const b2 = Math.max(0, b - 60);

  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="rgb(${r},${g},${b})"/>
        <stop offset="100%" stop-color="rgb(${r2},${g2},${b2})"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <text x="50%" y="50%" font-family="Helvetica, Arial, sans-serif"
          font-size="${Math.min(w, h) / 10}" font-weight="700"
          fill="white" fill-opacity="0.4"
          text-anchor="middle" dominant-baseline="middle">${label}</text>
  </svg>`;

  await sharp(Buffer.from(svg))
    .jpeg({ quality: 92 })
    .withMetadata({
      exif: {
        IFD0: {
          Make: 'TestCam',
          Model: 'Procedural-1',
          Software: 'seed_test_content.mjs',
        },
        ExifIFD: {
          LensModel: 'Synthetic 50mm f/1.4',
          FNumber: '1.8',
          ISO: '200',
          ExposureTime: '0.004',
          FocalLength: '50',
          DateTimeOriginal: '2026:05:12 14:23:45',
        },
      },
    })
    .toFile(outPath);
}

function albumMetaYaml(album) {
  return [
    `name: "${album.name}"`,
    `date: ${album.date}`,
    `description: "${album.description}"`,
    `keywords: [${album.keywords.map((k) => `"${k}"`).join(', ')}]`,
    `privacy: public`,
    `security_type: none`,
    `sort: filename`,
    ``,
  ].join('\n');
}

function folderMetaYaml(folder) {
  return [
    `name: "${folder.name}"`,
    `privacy: public`,
    ``,
  ].join('\n');
}

async function main() {
  console.log(`Seeding ${ROOT}`);
  await mkdir(ROOT, { recursive: true });
  await mkdir(PORTFOLIO_ROOT, { recursive: true });

  // Also write a site.yaml so local dev works without manual setup.
  const sitePath = resolve(PORTFOLIO_ROOT, 'site.yaml');
  const siteYaml = [
    `site_url: http://localhost:4321`,
    `assets_base_url: ""`,
    `name: "Test Portfolio"`,
    `short_name: "Test"`,
    `tagline: "Procedurally generated fixtures for local UI work."`,
    `copyright_holder: "Test Fixture"`,
    `homepage:`,
    `  hero_title: "Test Portfolio"`,
    `  hero_subtitle: "Fixtures for local development."`,
    ``,
  ].join('\n');
  await writeFile(sitePath, siteYaml);
  console.log(`  wrote ${sitePath}`);

  for (const group of FIXTURES) {
    const folderPath = resolve(ROOT, group.folder.url_name);
    await mkdir(folderPath, { recursive: true });
    await writeFile(resolve(folderPath, 'meta.yaml'), folderMetaYaml(group.folder));

    for (const album of group.albums) {
      const albumPath = resolve(folderPath, album.url_name);
      await mkdir(albumPath, { recursive: true });
      await writeFile(resolve(albumPath, 'meta.yaml'), albumMetaYaml(album));

      for (let i = 0; i < album.photos; i++) {
        const color = album.palette[i % album.palette.length];
        const size = SIZES[i % SIZES.length];
        const filename = `${album.url_name.toLowerCase()}-${String(i + 1).padStart(3, '0')}.jpg`;
        const outPath = resolve(albumPath, filename);
        const label = `${album.url_name} ${i + 1}`;
        await makeGradientJpeg(outPath, color, label, size);
        process.stdout.write('.');
      }
      console.log(` ${album.url_name} (${album.photos})`);
    }
  }

  console.log('\nDone. Set content_root in .config.yaml to:');
  console.log(`  ${PORTFOLIO_ROOT}`);
  console.log('Photos were seeded into the content/ subdirectory:');
  console.log(`  ${ROOT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
