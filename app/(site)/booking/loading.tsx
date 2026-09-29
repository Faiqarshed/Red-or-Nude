// BookingView's layout while it loads: the branch picker and the service cards,
// with the summary beside them on a wide screen.
import { Bone, SkeletonPage } from "@/components/PageSkeleton";

export default function Loading() {
  return (
    <SkeletonPage className="grid max-w-page gap-8 lg:grid-cols-[1fr_360px] lg:px-16">
      <div className="space-y-10">
        <div>
          <Bone className="mb-5 h-8 w-48 rounded-xl" />
          <div className="flex flex-wrap gap-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Bone key={i} className="h-11 w-32 rounded-[14px]" />
            ))}
          </div>
        </div>
        <div>
          <Bone className="mb-5 h-8 w-56 rounded-xl" />
          <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Bone key={i} className="h-[196px] rounded-[20px]" />
            ))}
          </div>
        </div>
        {/* Book for a group, and the memberships row. */}
        <Bone className="h-[76px] rounded-[20px]" />
        <Bone className="h-[76px] rounded-[20px]" />
      </div>
      <Bone className="h-[420px] rounded-[24px] lg:sticky lg:top-[110px]" />
    </SkeletonPage>
  );
}
