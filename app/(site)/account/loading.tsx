"use client";

// AccountView's layout while it loads. Signed in: her name, then the bookings
// beside the points, memberships and profile. Signed out: the narrow sign-in
// card. Which one is known here the same way the header knows (useAccount).
import { Bone, SkeletonPage } from "@/components/PageSkeleton";
import { useAccount } from "@/lib/account/context";

export default function Loading() {
  const signedIn = useAccount();

  if (!signedIn) {
    return (
      <SkeletonPage className="max-w-[520px]">
        <Bone className="h-9 w-48 rounded-xl" />
        <Bone className="mt-2 h-4 w-72 rounded-lg" />
        <Bone className="mt-7 h-[220px] rounded-[20px]" />
      </SkeletonPage>
    );
  }

  return (
    <SkeletonPage className="max-w-page lg:px-16">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Bone className="h-9 w-56 rounded-xl" />
          <Bone className="mt-2 h-4 w-40 rounded-lg" />
        </div>
        <Bone className="h-9 w-24 rounded-[12px]" />
      </div>
      <div className="mt-8 grid items-start gap-8 lg:grid-cols-[1fr_380px] lg:grid-rows-[auto_1fr]">
        <div className="space-y-6 self-start lg:col-start-2 lg:row-start-1">
          <Bone className="h-[180px] rounded-[20px]" />
          <Bone className="h-[140px] rounded-[20px]" />
        </div>
        <div className="self-start lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <Bone className="h-6 w-40 rounded-lg" />
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Bone key={i} className="h-[168px] rounded-[20px]" />
            ))}
          </div>
        </div>
        <Bone className="h-[320px] self-start rounded-[20px] lg:col-start-2 lg:row-start-2" />
      </div>
    </SkeletonPage>
  );
}
