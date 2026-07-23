// Catch-all 404 inside the admin shell — see the note in the site's equivalent.
// Rendering inside (shell) means an unknown /admin URL still shows the sidebar,
// so staff can navigate onward instead of hitting a dead end.

import NotFoundView from "./NotFoundView";

export default function NotFound() {
  return <NotFoundView />;
}
