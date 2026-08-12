import assert from "node:assert/strict";
import test from "node:test";
import { SecureEvidenceFetcher, type EvidenceFetchDependencies } from "../src/index.ts";

const body = (value: string) => new TextEncoder().encode(value);
const publicDns = async () => ["93.184.216.34"];

test("secure evidence fetch pins DNS, strips executable HTML and emits hash citation metadata", async () => {
  const calls: Array<{ host: string; address: string }> = [];
  const fetcher = new SecureEvidenceFetcher({}, {
    resolveHost: publicDns,
    now: () => "2026-08-13T00:00:00.000Z",
    transport: async ({ url, pinnedAddress }) => {
      calls.push({ host: url.hostname, address: pinnedAddress });
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: body("<html><script>steal()</script><style>x</style><p>核验发件域名 &amp; 官方渠道</p></html>") };
    },
  });
  const evidence = await fetcher.fetch("https://security.example.test/guide");
  assert.deepEqual(calls, [{ host: "security.example.test", address: "93.184.216.34" }]);
  assert.equal(evidence.text, "核验发件域名 & 官方渠道");
  assert.equal(evidence.locator.quote, evidence.text);
  assert.match(evidence.urlHash, /^[a-f0-9]{64}$/);
  assert.match(evidence.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(evidence).includes("https://"), false);
});

test("secure evidence fetch rejects credentials, IP literals and private DNS before transport", async () => {
  let transported = 0;
  const dependencies: EvidenceFetchDependencies = { resolveHost: async () => ["127.0.0.1"], transport: async () => { transported += 1; throw new Error("unused"); } };
  const fetcher = new SecureEvidenceFetcher({}, dependencies);
  await assert.rejects(fetcher.fetch("https://example.test/a"), /not a public address/);
  await assert.rejects(fetcher.fetch("https://user:pass@example.test/a"), /evidence_url_invalid/);
  await assert.rejects(fetcher.fetch("http://example.test/a"), /evidence_url_invalid/);
  await assert.rejects(fetcher.fetch("http://169.254.169.254/latest/meta-data"), /evidence_url_invalid/);
  assert.equal(transported, 0);
});

test("expanded mapped IPv6, NAT64 private targets and transition tunnels fail closed",async()=>{for(const address of ["0:0:0:0:0:ffff:7f00:1","64:ff9b::a00:1","2002:7f00:1::","2001:0000:4136:e378:8000:63bf:3fff:fdd2"]){let transported=0;const fetcher=new SecureEvidenceFetcher({}, {resolveHost:async()=>[address],transport:async()=>{transported++;throw new Error("unused")}});await assert.rejects(fetcher.fetch("https://example.test/a"),/not a public address/);assert.equal(transported,0)}});

test("absolute wall-clock deadline covers DNS and cannot be kept alive by a slow transport",async()=>{const dnsSlow=new SecureEvidenceFetcher({timeoutMs:1000},{resolveHost:async()=>await new Promise<readonly string[]>(()=>{}),transport:async()=>{throw new Error("unused")}});await assert.rejects(dnsSlow.fetch("https://example.test/a"),/timed out/);const transportSlow=new SecureEvidenceFetcher({timeoutMs:1000},{resolveHost:publicDns,transport:async()=>await new Promise(()=>{})});await assert.rejects(transportSlow.fetch("https://example.test/a"),/timed out/)});

test("each redirect is re-resolved and a redirect to private space fails closed", async () => {
  const resolved: string[] = [];
  let requests = 0;
  const fetcher = new SecureEvidenceFetcher({}, {
    resolveHost: async (host) => { resolved.push(host); return host === "public.example.test" ? ["93.184.216.34"] : ["10.0.0.8"]; },
    transport: async () => { requests += 1; return { status: 302, headers: { location: "https://internal.example.test/secret" }, body: body("") }; },
  });
  await assert.rejects(fetcher.fetch("https://public.example.test/start"), /not a public address/);
  assert.deepEqual(resolved, ["public.example.test", "internal.example.test"]);
  assert.equal(requests, 1);
});

test("stream/body ceiling and MIME policy fail closed", async () => {
  const oversized = new SecureEvidenceFetcher({ maxBytes: 1024 }, { resolveHost: publicDns, transport: async () => ({ status: 200, headers: { "content-type": "text/plain" }, body: new Uint8Array(1025) }) });
  await assert.rejects(oversized.fetch("https://example.test/large"), /size limit/);
  const binary = new SecureEvidenceFetcher({}, { resolveHost: publicDns, transport: async () => ({ status: 200, headers: { "content-type": "application/octet-stream" }, body: body("binary") }) });
  await assert.rejects(binary.fetch("https://example.test/file"), /content type/);
});
