import { DocumentPage, documentMetadata } from "@/components/trust/document-page";

export const metadata = documentMetadata("eula", "/eula");
export const revalidate = 300;

export default function Page() {
  return <DocumentPage kind="eula" />;
}
