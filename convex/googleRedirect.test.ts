import { describe, expect, test } from "vitest";

import { redirectUri } from "./lib/google/oauth";

describe("Where Google sends an Owner back", () => {
  test("is the deployment's own site address unless a Selestial-domain return is set", () => {
    expect(redirectUri({ CONVEX_SITE_URL: "https://stoic-gazelle-731.convex.site/" })).toBe("https://stoic-gazelle-731.convex.site/oauth/google/callback");
    expect(redirectUri({ CONVEX_SITE_URL: "https://stoic-gazelle-731.convex.site", GOOGLE_OAUTH_REDIRECT_URI: "https://app.selestial.io/oauth/google/callback" })).toBe("https://app.selestial.io/oauth/google/callback");
    expect(redirectUri({})).toBeNull();
  });

  test("ignores a setting that isn't an https address ending in the callback path", () => {
    for (const bad of ["http://app.selestial.io/oauth/google/callback", "https://app.selestial.io/somewhere-else", "https://app.selestial.io/oauth/google/callback?x=1", "app.selestial.io/oauth/google/callback"]) {
      expect(redirectUri({ CONVEX_SITE_URL: "https://stoic-gazelle-731.convex.site", GOOGLE_OAUTH_REDIRECT_URI: bad })).toBe("https://stoic-gazelle-731.convex.site/oauth/google/callback");
    }
  });
});
