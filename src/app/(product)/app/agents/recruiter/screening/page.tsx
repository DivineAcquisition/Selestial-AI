import { redirect } from "next/navigation";

/** Screening decisions are a view of Applicants now (Recruiter's four tabs, November 23, 2026). Old links land there. */
export default function Page() {
  redirect("/app/agents/recruiter/applicants?view=decisions");
}
