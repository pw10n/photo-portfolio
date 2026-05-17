import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const albumImageSchema = z.object({
  image_id: z.string().regex(/^[a-z2-7]{11}$/),
  filename: z.string(),
  caption: z.string().default(''),
  keywords: z.array(z.string()).default([]),
});

const albumSchema = z.object({
  id: z.string().regex(/^alb_[A-Za-z0-9]+$/),
  url_path: z.string(),
  url_name: z.string(),
  name: z.string(),
  description: z.string().default(''),
  keywords: z.array(z.string()).default([]),
  date: z.string().nullable().default(null),
  privacy: z.enum(['public', 'unlisted']),
  security_type: z.enum(['none', 'password']),
  password_hash: z.string().nullable().default(null),
  password_salt: z.string().nullable().default(null),
  password_hint: z.string().nullable().default(null),
  sort: z.enum(['filename', 'date', 'manual']).default('filename'),
  hero: z.string().nullable().default(null),
  parent_path: z.string(),
  images: z.array(albumImageSchema),
});

const folderSchema = z.object({
  url_path: z.string(),
  url_name: z.string(),
  name: z.string(),
  description: z.string().default(''),
  privacy: z.enum(['public', 'unlisted']),
  parent_path: z.string().nullable().default(null),
  child_paths: z.array(z.string()),
});

export const collections = {
  albums: defineCollection({
    loader: glob({ pattern: '**/*.json', base: './src/content/albums' }),
    schema: albumSchema,
  }),
  folders: defineCollection({
    loader: glob({ pattern: '**/*.json', base: './src/content/folders' }),
    schema: folderSchema,
  }),
};

export type Album = z.infer<typeof albumSchema>;
export type Folder = z.infer<typeof folderSchema>;
export type AlbumImage = z.infer<typeof albumImageSchema>;
