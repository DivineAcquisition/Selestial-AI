/**
 * Which Convex address the app's browser connection uses in a production build (docs/foundation/06-deployments.md).
 *
 * `npx convex deploy` names the deployment's client address, and a custom domain set in the Convex dashboard
 * can take its place. A Convex custom domain serves only one side: the client API the app's WebSocket needs,
 * or the HTTP routes people see (webhooks, the public API and MCP, links). On November 22, 2026 the build was
 * given api.selestial.io while that domain served HTTP routes: every signed-in screen waited forever.
 *
 * So the app always connects on the deployment's own `<name>.convex.cloud` address, which always serves the
 * client API. Custom domains are for the addresses people see. If the given address differs, the deployment's
 * own one is used and the build log says why; if it can't be checked, the build says so and carries on.
 */

/** The deployment a Convex deploy key belongs to: "prod:stoic-gazelle-731|…" → "stoic-gazelle-731". */
export function deploymentFromKey(key) {
  const match = /^(?:prod|preview|dev):([a-z]+-[a-z]+-\d+)\|/.exec((key ?? "").trim());
  return match ? match[1] : null;
}

/**
 * Chooses the client address. `fallbackName` is the production deployment named in the repository, used only
 * when the key doesn't say which deployment it is. Answers the address (null: none can be used) and log lines.
 */
export async function clientAddress({ given, deployKey, fallbackName, fetchImpl }) {
  const log = [];
  const name = deploymentFromKey(deployKey) ?? fallbackName ?? null;
  const own = name ? `https://${name}.convex.cloud` : null;
  const named = (given ?? "").trim().replace(/\/+$/, "") || null;
  let url = named;
  if (own && named !== own) {
    log.push(`Convex named ${named ?? "no address"} as the app's address. The app connects on ${own} instead: custom domains are for the HTTP routes people see, and only the deployment's own address is sure to serve the app.`);
    url = own;
  }
  if (!url) {
    log.push("No Convex address for the app, and the deploy key doesn't say which deployment it is. The build stops so a site that can't sign anyone in is never published.");
    return { url: null, log };
  }
  try {
    const response = await fetchImpl(`${url}/version`, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) log.push(`The app connects on ${url} (it answers as the Convex client API).`);
    else if (url === own) log.push(`Warning: ${url}/version answered ${response.status}. Building against it anyway: it is the deployment's own address.`);
    else {
      log.push(`${url} doesn't answer as the Convex client API (${response.status}), and there is no deployment address to use instead. The build stops.`);
      return { url: null, log };
    }
  } catch {
    log.push(`Warning: couldn't reach ${url}/version to check it. Building against it anyway.`);
  }
  return { url, log };
}
