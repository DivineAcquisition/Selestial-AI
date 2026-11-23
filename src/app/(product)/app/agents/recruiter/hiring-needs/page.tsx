import { redirect } from "next/navigation";

/** Roles are part of Hiring setup now (Recruiter's four tabs, November 23, 2026). Old links land there. */
export default function Page() {
  redirect("/app/agents/recruiter/hiring-setup#roles");
}
