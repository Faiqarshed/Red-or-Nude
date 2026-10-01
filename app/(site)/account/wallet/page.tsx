// Every movement of her wallet, for the figures the header and the account card
// sum up but only list the latest of. Signed in only: a wallet is her email,
// and the session is the proof.

import { redirect } from "next/navigation";
import { currentCustomer } from "@/lib/account/guard";
import { accountWallet } from "@/lib/wallet";
import WalletHistoryView from "./WalletHistoryView";

export const metadata = { title: "Red Or Nude — Wallet" };

// Reading the session cookie makes this per-request.
export const dynamic = "force-dynamic";

export default async function WalletHistoryPage() {
  const customer = await currentCustomer();
  if (!customer) redirect("/account?next=/account/wallet");
  // 500 is far past any real ledger (tens of rows); page it if one gets near.
  return <WalletHistoryView wallet={await accountWallet(customer.email, 500)} />;
}
