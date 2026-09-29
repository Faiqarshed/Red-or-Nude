// Her staff discount code and how to use it (brief §3.3).
//
// Its own page rather than a banner above every home screen: a technician's
// board is the screen she works from, and the code is something she looks up
// once a month. Reception and technicians only: the owner and admins hold no
// code. It loads the code by the session's id, never the request's.

import { requirePage } from "@/lib/auth/guard";
import { myStaffCode, STAFF_CODE_PERCENT } from "@/lib/staff-codes";
import MyCodeView from "./MyCodeView";

export const dynamic = "force-dynamic";

export default async function MyCodePage() {
  const user = await requirePage("staff.discount");
  const code = await myStaffCode(user.id);
  // The code's own figure when there is one; the salon's number before hers is issued.
  return <MyCodeView code={code} percent={code?.percent ?? STAFF_CODE_PERCENT} />;
}
