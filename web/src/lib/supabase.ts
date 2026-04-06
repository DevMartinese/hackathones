import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.PUBLIC_SUPABASE_URL;
const key = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

if (!url || !key) {
  throw new Error(
    "Missing PUBLIC_SUPABASE_URL or PUBLIC_SUPABASE_ANON_KEY env vars"
  );
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

export type HackathonRow = {
  id: string;
  slug: string;
  name: string;
  date_start: string | null;
  date_end: string | null;
  country: string | null;
  city: string | null;
  location: string | null;
  url: string | null;
  source: string;
  type: string | null;
  tags: string[] | null;
  description: string | null;
  status: string;
  created_at: string | null;
  updated_at: string | null;
};

export type LfgRow = {
  id: string;
  handle: string;
  skills: string[] | null;
  hackathon_id: string | null;
  hackathon_name: string;
  contact: string;
  message: string | null;
  status: string;
  created_at: string | null;
};
