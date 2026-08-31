// Supabase client (server-side, 用 service_role key)

import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.error("❌ 找不到 SUPABASE_URL 或 SUPABASE_SERVICE_KEY");
  console.error("   請至 .env 填入 Supabase 憑證");
  process.exit(1);
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false },
});
