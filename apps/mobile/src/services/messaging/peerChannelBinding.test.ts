// @vitest-environment node
import { webcrypto } from "node:crypto";
import { expect, it } from "vitest";
import { derivePeerChannelBinding } from "./peerChannelBinding";
const id = (n: number) => `00000000-0000-4000-9006-${String(n).padStart(12, "0")}`;
const local = "AB:".repeat(31) + "AB", remote = "CD:".repeat(31) + "CD";
function connection(a = local, b = remote, state = "connected") {
  const stats = new Map([
    ["transport", { type: "transport", dtlsState: state, localCertificateId: "local", remoteCertificateId: "remote" }],
    ["local", { type: "certificate", fingerprintAlgorithm: "sha-256", fingerprint: a }],
    ["remote", { type: "certificate", fingerprintAlgorithm: "sha-256", fingerprint: b }],
  ]);
  return { getStats: async () => stats };
}
it("derives symmetric binding from the local transport's actual certificate-stat references", async () => {
  const crypto = webcrypto as unknown as Crypto;
  const a = await derivePeerChannelBinding(connection(), id(1), id(2), crypto);
  const b = await derivePeerChannelBinding(connection(remote, local), id(2), id(1), crypto);
  expect(a).toBe(b); expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(await derivePeerChannelBinding(connection(local, "EF:".repeat(31) + "EF"), id(1), id(2), crypto)).not.toBe(a);
});
it("fails closed rather than binding peer-supplied SDP or disconnected/missing certificate stats", async () => {
  const crypto = webcrypto as unknown as Crypto;
  await expect(derivePeerChannelBinding(connection(local, remote, "connecting"), id(1), id(2), crypto)).rejects.toThrow();
  await expect(derivePeerChannelBinding(connection("bad"), id(1), id(2), crypto)).rejects.toThrow();
  await expect(derivePeerChannelBinding({ getStats: async () => new Map() }, id(1), id(2), crypto)).rejects.toThrow();
  await expect(derivePeerChannelBinding(connection(), id(1), id(1), crypto)).rejects.toThrow();
});
