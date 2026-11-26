import { RoleApplyPage } from "@/components/applicant/public-apply";

export default async function Page({ params }: { params: Promise<{ handle: string; role: string }> }) {
  const { handle, role } = await params;
  return <RoleApplyPage handle={handle.toLowerCase()} slug={role.toLowerCase()} />;
}
