import { defineCollection, z } from "astro:content";
import { file } from "astro/loaders";

const hackathons = defineCollection({
  loader: file("src/data/hackathons.json"),
  schema: z.object({
    id: z.string(),
    name: z.string(),
    date_start: z.string().nullable(),
    date_end: z.string().nullable(),
    city: z.string().nullable(),
    location: z.string().nullable(),
    url: z.string().nullable(),
    source: z.enum(["x", "luma"]),
    type: z.enum(["presencial", "online", "hibrido"]).nullable(),
    tags: z.array(z.string()),
    description: z.string(),
  }),
});

export const collections = { hackathons };
