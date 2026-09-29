// MyBookingsView's layout while it loads: the narrow column with the title and
// the booking reference box.
import { Bone, SkeletonPage } from "@/components/PageSkeleton";

export default function Loading() {
  return (
    <SkeletonPage className="max-w-[760px]">
      <Bone className="h-9 w-56 rounded-xl" />
      <Bone className="mt-2 h-4 w-72 rounded-lg" />
      <Bone className="mt-3 h-4 w-60 rounded-lg" />
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Bone className="h-[66px] flex-1 rounded-[12px]" />
        <Bone className="h-[46px] w-32 self-end rounded-[12px]" />
      </div>
    </SkeletonPage>
  );
}
