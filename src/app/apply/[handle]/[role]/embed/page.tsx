import { RoleEmbed } from "@/components/applicant/public-apply";

export default async function Page({ params }: { params: Promise<{ handle: string; role: string }> }) {
  const { handle, role } = await params;
  return <RoleEmbed handle={handle.toLowerCase()} slug={role.toLowerCase()} />;
}
