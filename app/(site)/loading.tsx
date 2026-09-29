// The public site's equivalent of the panel's loading.tsx — see the reasoning
// there. Same problem, same fix: every page is `force-dynamic`, so a navigation
// is a full server render, and without this the customer waits on the previous
// page with nothing to say a new one is coming.
//
// The only loader on the site: it picks the shape of the page she is going to
// (components/PageSkeleton.tsx), so no nested loader can flash before it.
import { SiteSkeleton } from "@/components/PageSkeleton";

export default function Loading() {
  return <SiteSkeleton />;
}
