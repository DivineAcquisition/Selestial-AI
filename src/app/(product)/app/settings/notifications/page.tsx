import type { Metadata } from "next";
import Link from "next/link";

import { IssueCards } from "@/components/app/issues/issue-cards";
import { NotificationPreferences } from "@/components/app/settings/notification-preferences";
import { SectionPage } from "@/components/app/settings/section-page";

export const metadata: Metadata = { title: "My notifications" };

export default function Page() {
  return (
    <SectionPage id="notifications">
      <div className="grid gap-6">
        <IssueCards place="notifications" />
        <NotificationPreferences />
        <p className="text-sm text-muted-foreground">
          Looking for the emails Selestial sends your customers, applicants and cleaners? They are in{" "}
          <Link href="/app/settings/company-messages" className="font-medium text-brand-600 underline-offset-2 hover:underline">
            Company messages &amp; previews
          </Link>
          .
        </p>
      </div>
    </SectionPage>
  );
}
