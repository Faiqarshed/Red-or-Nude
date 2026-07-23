import { config } from "dotenv";
import type { Config } from "drizzle-kit";

// drizzle-kit runs outside Next, so it doesn't pick up .env.local on its own.
config({ path: ".env.local" });

export default {
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
  verbose: true,
  strict: true,
} satisfies Config;
