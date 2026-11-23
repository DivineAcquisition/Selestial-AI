import type { NextConfig } from "next";

const securityHeaders = [
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

/**
 * The backend's HTTP routes address, from the app's own connection address (<name>.convex.cloud →
 * <name>.convex.site). The production build always sets the deployment's own address (scripts/next-build.mjs).
 */
function convexSite(): string | null {
  const match = /^https:\/\/([a-z0-9-]+)\.convex\.cloud\/?$/i.exec(process.env.NEXT_PUBLIC_CONVEX_URL?.trim() ?? "");
  return match ? `https://${match[1].toLowerCase()}.convex.site` : null;
}

const nextConfig: NextConfig = {
  // Google's return after an Owner allows access lands on Selestial's own domain, which Google can verify, and
  // is passed straight through to the backend that handles it (convex/lib/google/oauth.ts, redirectUri). The
  // backend's answer, a redirect into the app, comes back to the browser unchanged. Nothing is read or kept here.
  async rewrites() {
    const site = convexSite();
    return site ? { beforeFiles: [{ source: "/oauth/google/callback", destination: `${site}/oauth/google/callback` }], afterFiles: [], fallback: [] } : [];
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // A link is a credential: its address is never sent on to another site. The cleaner pages may ask for
      // the phone's position, for check-in. It is allowed on all of them because the offer page leads to the
      // job page without a fresh page load, and a page keeps the policy it was loaded with.
      {
        source: "/c/:path*",
        headers: [
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self), payment=()" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      // Google's return carries a one-time code in its address: never cached, indexed or sent on.
      {
        source: "/oauth/google/callback",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      // The pay page runs Stripe's payment form, which may offer Apple Pay or Google Pay from Stripe's frame.
      // Listed after the rule above so its Permissions-Policy is the one that applies there.
      {
        source: "/c/pay/:path*",
        headers: [{ key: "Permissions-Policy", value: 'camera=(), microphone=(), geolocation=(), payment=(self "https://js.stripe.com")' }],
      },
      // Booking pages: a private booking link is a credential, so it is never passed on, cached or indexed.
      // They run Stripe's payment form like the pay page.
      {
        source: "/b/:path*",
        headers: [
          { key: "Permissions-Policy", value: 'camera=(), microphone=(), geolocation=(), payment=(self "https://js.stripe.com")' },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      // The embeddable entry (a ZIP box) may sit inside a company's own website. It holds no session and
      // sends the visitor to the full page in a new tab, so framing it exposes nothing.
      {
        source: "/b/:handle/:slug/embed",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors *" }],
      },
      // A company's texting sign-up may be embedded on its own website (?embed=1). It holds no session.
      {
        source: "/b/:handle/texts",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors *" }],
      },
    ];
  },
};

export default nextConfig;
