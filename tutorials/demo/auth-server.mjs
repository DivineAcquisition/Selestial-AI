#!/usr/bin/env node
/**
 * Loopback token server for recording tutorials against a local Convex backend.
 * It signs one fictional owner (Jordan Reyes, jordan.reyes@example.com). It binds
 * to 127.0.0.1 only and never reads a real sign-in secret.
 *
 *   node tutorials/demo/auth-server.mjs
 *
 * The app trusts this server only while recording. Add the provider below to convex/auth.config.ts
 * locally and do not commit it: Convex requires every environment variable read from that file to be
 * set on production, so a committed provider would block the next deploy.
 *
 *   providers: [..., {
 *     type: "customJwt", applicationID: "convex", algorithm: "RS256",
 *     issuer: "http://127.0.0.1:8787",
 *     jwks: "http://127.0.0.1:8787/.well-known/jwks.json",
 *   }]
 *
 * Then set TUTORIAL_DEMO=local on the local backend, NEXT_PUBLIC_TUTORIAL_DEMO=local in .env.local,
 * and run the app at http://localhost:3100. Remove the provider when the recording is done.
 */
import { createServer } from "node:http";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";

const PORT = 8787;
const ISSUER = `http://127.0.0.1:${PORT}`;
const KID = "tutorial-demo-2";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
const publicJwk = { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", use: "sig", kid: KID };

function b64(value) {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.from(raw).toString("base64url");
}

function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: "RS256", typ: "JWT", kid: KID });
  const payload = b64({
    iss: ISSUER,
    sub: process.env.TUTORIAL_DEMO_SUBJECT || "tutorial-jordan-2",
    aud: "convex",
    iat: now,
    exp: now + 60 * 60 * 6,
    email: "jordan.reyes@example.com",
    email_verified: true,
    name: "Jordan Reyes",
  });
  const data = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(data).sign(privateKey).toString("base64url");
  return `${data}.${signature}`;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", ISSUER);
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, OPTIONS");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === "/.well-known/jwks.json") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ keys: [publicJwk] }));
    return;
  }
  if (url.pathname === "/token") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ token: token() }));
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Tutorial demo tokens at ${ISSUER}/token (${randomUUID().slice(0, 8)})`);
});
