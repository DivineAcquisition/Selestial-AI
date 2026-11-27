/**
 * The public documents and their versions: the one list the record and the website share. The text of
 * each version lives in the website (src/lib/trust/documents). A version is never edited after it is
 * published: a change is a new version with a new id, so an acceptance always points at the exact text.
 *
 * Pure: no Convex or Next.js imports, so both sides can use it.
 */
export const DOCUMENT_KINDS = ["terms", "privacy", "cookies", "messaging", "security", "eula"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export type DocumentVersion = {
  /** Never reused, for example "terms-2026-11-16". */
  id: string;
  kind: DocumentKind;
  title: string;
  /** The date it takes effect, YYYY-MM-DD. Chosen by the owner, not computed. */
  effectiveOn: string;
  /** What changed from the version before, in one line. */
  summary: string;
  /**
   * A material change people who already have an account are told about in the product (the Privacy notice
   * promises it): plain words shown in the workspace until they close it, for NOTICE_DAYS after effectiveOn.
   */
  notice?: string;
  /**
   * The owner approved this version for publication directly, so it is in force without a staff
   * publication record. Staff can still withdraw it in Staff › Trust: a record always wins.
   */
  ownerApproved?: { on: string; note: string };
};

export const DOCUMENT_TITLES: Record<DocumentKind, string> = {
  terms: "Terms of Service",
  privacy: "Privacy Notice",
  cookies: "Cookies and Tracking",
  messaging: "Messaging Practices",
  security: "Security Overview",
  eula: "End-User License Agreement",
};

/** Every version ever published, oldest first within a kind. */
export const DOCUMENT_VERSIONS: readonly DocumentVersion[] = [
  { id: "terms-2026-11-16", kind: "terms", title: DOCUMENT_TITLES.terms, effectiveOn: "2026-11-16", summary: "First version." },
  { id: "privacy-2026-11-16", kind: "privacy", title: DOCUMENT_TITLES.privacy, effectiveOn: "2026-11-16", summary: "First version." },
  { id: "privacy-2026-11-27", kind: "privacy", title: DOCUMENT_TITLES.privacy, effectiveOn: "2026-11-27", summary: "Says that a company's records are kept after its plan ends, and deleted within 90 days of the Owner asking or of a plan cancelled for non-payment.", notice: "A company's records now stay in its workspace after its plan ends, so it can come back or export them. They're deleted within 90 days when the Owner asks us to delete the company, or when a plan is cancelled for non-payment.", ownerApproved: { on: "2026-11-27", note: "The owner approved publishing the reworded retention line on 2026-11-27." } },
  { id: "cookies-2026-11-16", kind: "cookies", title: DOCUMENT_TITLES.cookies, effectiveOn: "2026-11-16", summary: "First version." },
  { id: "messaging-2026-11-16", kind: "messaging", title: DOCUMENT_TITLES.messaging, effectiveOn: "2026-11-16", summary: "First version." },
  { id: "security-2026-11-16", kind: "security", title: DOCUMENT_TITLES.security, effectiveOn: "2026-11-16", summary: "First version." },
  { id: "eula-2026-11-24", kind: "eula", title: DOCUMENT_TITLES.eula, effectiveOn: "2026-11-24", summary: "First version.", ownerApproved: { on: "2026-11-24", note: "The owner approved publishing the EULA on 2026-11-24." } },
];

/** How long a changed document is announced in the product after it takes effect. */
export const NOTICE_DAYS = 90;

/** The changes to announce now: versions with a notice, in force, effective within NOTICE_DAYS and newest of their kind. */
export function noticesDue(publications: readonly PublicationLike[], now: number): DocumentVersion[] {
  return DOCUMENT_VERSIONS.filter((version) => {
    if (!version.notice || currentVersion(version.kind).id !== version.id || !inForce(version, publications)) return false;
    const from = Date.parse(`${version.effectiveOn}T00:00:00Z`);
    return now >= from && now < from + NOTICE_DAYS * 86_400_000;
  });
}

/** The newest version of a kind: the one in force and the one a person accepts. */
export function currentVersion(kind: DocumentKind): DocumentVersion {
  const rows = DOCUMENT_VERSIONS.filter((row) => row.kind === kind);
  return rows[rows.length - 1];
}

export function versionById(id: string): DocumentVersion | null {
  return DOCUMENT_VERSIONS.find((row) => row.id === id) ?? null;
}

/** A staff publication record for a version, as the trust records hold it. */
export type PublicationLike = { documentId: string; status: string };

/**
 * Whether a version is in force: published by staff, or approved by the owner with no staff record
 * saying otherwise. A withdrawal in Staff › Trust always takes it out of force.
 */
export function inForce(version: DocumentVersion, publications: readonly PublicationLike[]): boolean {
  const record = publications.find((row) => row.documentId === version.id);
  if (record) return record.status === "published";
  return version.ownerApproved !== undefined;
}
