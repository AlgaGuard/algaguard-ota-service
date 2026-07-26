import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAuthenticator } from "../src/auth.js";

test("public issuer validation uses the configured private JWKS endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const issuer = "https://dev.algaguard.example/auth/realms/algaguard";
  const jwksUrl =
    "http://keycloak:8080/realms/algaguard/protocol/openid-connect/certs";
  const token = await new SignJWT({ scope: "ota.read" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject("demo-user")
    .setIssuer(issuer)
    .setAudience("algaguard-api")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return Response.json({ keys: [{ ...jwk, kid: "test-key", use: "sig" }] });
  };
  try {
    const authenticate = createAuthenticator({
      KEYCLOAK_ISSUER: issuer,
      KEYCLOAK_JWKS_URL: jwksUrl,
      KEYCLOAK_AUDIENCE: "algaguard-api",
    });
    assert.equal(
      (await authenticate(`Bearer ${token}`)).subjectId,
      "demo-user",
    );
    assert.deepEqual(urls, [jwksUrl]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
