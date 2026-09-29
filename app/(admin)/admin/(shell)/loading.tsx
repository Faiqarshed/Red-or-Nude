// What the panel shows while the next screen is being rendered on the server.
//
// Every page under here is `force-dynamic`, so navigating means waiting on a
// full server render plus its queries — and until this file existed there was no
// `loading.tsx` and no `Suspense` anywhere in the repo, so that wait was spent
// on the *old* screen with nothing moving. Clicking a nav item appeared to do
// nothing for a second and then the page swapped. That is most of what the salon
// reported as "the buttons are slow": not the work, the silence.
//
// Deliberately a skeleton and not a spinner: grey in the shape of the screen
// that is coming, while the shell around it (nav, header, branch picker) stays
// on screen and usable. The shapes are in components/admin/AdminSkeleton.tsx.
import AdminSkeleton from "@/components/admin/AdminSkeleton";

export default function Loading() {
  return <AdminSkeleton />;
}
