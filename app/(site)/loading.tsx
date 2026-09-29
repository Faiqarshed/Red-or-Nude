// The public site's equivalent of the panel's loading.tsx — see the reasoning
// there. Same problem, same fix: every page is `force-dynamic`, so a navigation
// is a full server render, and without this the customer waits on the previous
// page with nothing to say a new one is coming.
//
// The fallback for pages without their own. /booking, /account and
// /my-bookings have one each that copies their layout; see PageSkeleton.
import { Bone, SkeletonPage } from "@/components/PageSkeleton";

export default function Loading() {
  return (
    <SkeletonPage className="max-w-5xl space-y-4">
      <Bone className="h-8 w-56 rounded-xl" />
      <Bone className="h-64 rounded-2xl" />
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Bone key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
    </SkeletonPage>
  );
}
