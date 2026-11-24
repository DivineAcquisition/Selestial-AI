import { redirect } from "next/navigation";

/** Dispatch's rules have one editor: its Playbook, in the Dispatch workspace. Old links land there. */
export default function Page() {
  redirect("/app/agents/dispatch/playbook");
}
