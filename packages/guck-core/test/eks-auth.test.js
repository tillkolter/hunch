import test from "node:test";
import assert from "node:assert/strict";
import { buildEksToken } from "../dist/store/backends/eks-auth.js";

const decodeBase64Url = (value) => {
  let normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  while (normalized.length % 4 !== 0) {
    normalized += "=";
  }
  return Buffer.from(normalized, "base64").toString("utf8");
};

test("buildEksToken uses presigned GetCallerIdentity URL", async (t) => {
  try {
    const now = new Date("2024-01-01T00:00:00.000Z");
    const result = await buildEksToken({
      clusterName: "eks-example",
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        sessionToken: "token",
      },
      expiresInSeconds: 60,
      now,
    });
    assert.ok(result.token.startsWith("k8s-aws-v1."));
    const encoded = result.token.slice("k8s-aws-v1.".length);
    const url = decodeBase64Url(encoded);
    assert.match(url, /X-Amz-Algorithm=AWS4-HMAC-SHA256/);
    assert.match(url, /X-Amz-SignedHeaders=.*x-k8s-aws-id/);
    assert.equal(result.expiresAtMs, now.getTime() + 60 * 1000);
  } catch (error) {
    if (error instanceof Error && error.message.includes("EKS auth requires")) {
      t.skip("Optional AWS SDK deps not installed.");
      return;
    }
    throw error;
  }
});
