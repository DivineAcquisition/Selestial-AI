/** The part of the sign-in service's public settings that says which social sign-ins are on. */
export type SocialSettings = { social?: Record<string, { enabled?: unknown; authenticatable?: unknown } | undefined> } | null | undefined;

/** Whether people can sign in and create accounts with Google. Off unless the service says it is on, so the button never leads nowhere. */
export function googleEnabled(settings: SocialSettings): boolean {
  const google = settings?.social?.oauth_google;
  return google?.enabled === true && google.authenticatable !== false;
}
