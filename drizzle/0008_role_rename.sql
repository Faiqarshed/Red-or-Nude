-- Hand-written. drizzle-kit generates a DROP TYPE / CREATE TYPE pair here, which
-- fails the moment a staff row already holds 'owner' or 'manager' — the cast to
-- the new enum has nowhere to land. Renaming the values keeps every existing row
-- valid and needs no data migration.
--
-- brief §3: the salon calls these roles CEO and Admin. Admin is deliberately not
-- god mode; see the capability matrix in lib/auth/rbac.ts.
ALTER TYPE "public"."staff_role" RENAME VALUE 'owner' TO 'ceo';--> statement-breakpoint
ALTER TYPE "public"."staff_role" RENAME VALUE 'manager' TO 'admin';
