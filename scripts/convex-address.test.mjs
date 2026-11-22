/**
 * The production build's guard on the app's Convex address (scripts/convex-address.mjs). On November 22, 2026
 * a custom domain serving HTTP routes was baked in as the app's address and no signed-in screen loaded.
 */
import { describe, expect, it } from "vitest";

import { clientAddress, deploymentFromKey } from "./convex-address.mjs";

const KEY = "prod:stoic-gazelle-731|eyJ2MiI6ImV4YW1wbGUifQ==";
const answers = (map) => async (url) => {
  const status = map[url];
  if (status === "throw") throw new Error("unreachable");
  return { ok: status === 200, status: status ?? 404 };
};

describe("the app's Convex address in a production build", () => {
  it("reads the deployment from a deploy key", () => {
    expect(deploymentFromKey(KEY)).toBe("stoic-gazelle-731");
    expect(deploymentFromKey("preview:happy-otter-123|x")).toBe("happy-otter-123");
    expect(deploymentFromKey("something-else")).toBeNull();
    expect(deploymentFromKey(undefined)).toBeNull();
  });

  it("replaces a custom domain with the deployment's own address, and says why", async () => {
    const chosen = await clientAddress({ given: "https://api.selestial.io", deployKey: KEY, fetchImpl: answers({ "https://stoic-gazelle-731.convex.cloud/version": 200 }) });
    expect(chosen.url).toBe("https://stoic-gazelle-731.convex.cloud");
    expect(chosen.log[0]).toContain("Convex named https://api.selestial.io as the app's address");
  });

  it("replaces it even while the custom domain happens to serve the client API, so a later switch can't break sign-in", async () => {
    const chosen = await clientAddress({ given: "https://api.selestial.io", deployKey: KEY, fetchImpl: answers({ "https://api.selestial.io/version": 200, "https://stoic-gazelle-731.convex.cloud/version": 200 }) });
    expect(chosen.url).toBe("https://stoic-gazelle-731.convex.cloud");
  });

  it("keeps the deployment's own address as given, without a note", async () => {
    const chosen = await clientAddress({ given: "https://stoic-gazelle-731.convex.cloud/", deployKey: KEY, fetchImpl: answers({ "https://stoic-gazelle-731.convex.cloud/version": 200 }) });
    expect(chosen).toEqual({ url: "https://stoic-gazelle-731.convex.cloud", log: ["The app connects on https://stoic-gazelle-731.convex.cloud (it answers as the Convex client API)."] });
  });

  it("uses the repository's production deployment when the key doesn't say which it is", async () => {
    const chosen = await clientAddress({ given: "https://api.selestial.io", deployKey: "opaque", fallbackName: "stoic-gazelle-731", fetchImpl: answers({}) });
    expect(chosen.url).toBe("https://stoic-gazelle-731.convex.cloud");
    expect(chosen.log.at(-1)).toContain("Warning");
  });

  it("stops the build when nothing usable is known, and carries on with a warning when the check can't run", async () => {
    expect((await clientAddress({ given: "https://api.selestial.io", deployKey: "opaque", fetchImpl: answers({ "https://api.selestial.io/version": 404 }) })).url).toBeNull();
    expect((await clientAddress({ given: undefined, deployKey: undefined, fetchImpl: answers({}) })).url).toBeNull();
    const offline = await clientAddress({ given: undefined, deployKey: KEY, fetchImpl: answers({ "https://stoic-gazelle-731.convex.cloud/version": "throw" }) });
    expect(offline.url).toBe("https://stoic-gazelle-731.convex.cloud");
    expect(offline.log.at(-1)).toContain("couldn't reach");
  });
});
