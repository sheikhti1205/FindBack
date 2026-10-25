// Isolated localhost probe: library stream errors must not terminate the API process.
// Optional argv[2] selects an archived pre-patch body-parser for RED reproduction.
import express from "express";
import { request } from "node:http";
import { once } from "node:events";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { Buffer } from "node:buffer";
import process from "node:process";
import { setTimeout } from "node:timers";
import console from "node:console";

const bodyParser = (await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : "body-parser")).default;
const app = express();
app.use(bodyParser.json({ limit: "1mb" }));
app.post("/probe", (req, res) => res.json({ parsed: req.body?.probe === true }));
app.use((_err, _req, res, _next) => res.status(400).end());
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;

function send(bytes, encoding, trailer) {
  return new Promise((resolve, reject) => {
    let response, finished = false;
    const complete = () => { if (finished && response) resolve(response); };
    const req = request({ hostname: "127.0.0.1", port, path: "/probe", method: "POST", headers: {
      "Content-Type": "application/json", "Content-Length": bytes.length + (trailer?.length ?? 0),
      ...(encoding ? { "Content-Encoding": encoding } : {}),
    } }, (res) => {
      let body = "";
      res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
      res.on("end", () => { response = { status: res.statusCode, body }; complete(); });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("finish", () => { finished = true; complete(); });
    if (trailer) {
      req.write(bytes);
      // Deliberately separate decoder EOF from HTTP request EOF. Sending all
      // bytes at once merely exercises ordinary malformed-gzip handling.
      setTimeout(() => req.end(trailer), 40);
    } else req.end(bytes);
  });
}

try {
  const body = Buffer.from('{"probe":true}');
  const valid = await send(gzipSync(body), "gzip");
  assert.equal(valid.status, 200);
  assert.deepEqual(JSON.parse(valid.body), { parsed: true });
  const malformed = [];
  for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync]]) {
    const result = await send(compress(body), encoding, Buffer.from("trailing-invalid-frame"));
    // A completed decoder may deliver valid JSON before the trailing bytes;
    // the contract is safe rejection OR parsed JSON, never a process crash.
    assert.ok([200, 400].includes(result.status));
    if (result.status === 200) assert.deepEqual(JSON.parse(result.body), { parsed: true });
    malformed.push(result.status);
  }
  const healthy = await send(body);
  assert.equal(healthy.status, 200);
  assert.deepEqual(JSON.parse(healthy.body), { parsed: true });
  console.log(JSON.stringify({ valid: valid.status, malformed, healthy: healthy.status }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
