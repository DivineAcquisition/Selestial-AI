import type { Metadata } from "next";

import { InternalBookingScreen } from "@/components/app/sales/internal-booking-screen";

export const metadata: Metadata = { title: "Internal Booking" };

export default function Page() {
  return <InternalBookingScreen />;
}
