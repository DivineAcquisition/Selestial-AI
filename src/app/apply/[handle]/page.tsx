import { CareersPage } from "@/components/applicant/public-apply";

export default async function Page({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  return <CareersPage handle={handle.toLowerCase()} />;
}
