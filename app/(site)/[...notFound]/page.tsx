// Unmatched public URL → the group's not-found.tsx boundary, which returns a
// real 404 status. Without this catch-all the request escapes both root layouts
// and falls through to the pages-router error document.
import { notFound } from "next/navigation";

export default function CatchAll(): never {
  notFound();
}
