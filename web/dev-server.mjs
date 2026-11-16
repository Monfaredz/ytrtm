// Local stand-in for Netlify: serves web/public and routes /api/ytm to the same
// function, so the whole thing can be tested on the phone over the LAN.
//
//   node dev-server.mjs            # http://localhost:8890
//   APP_KEY=secret node dev-server.mjs
//
// It is not a proxy: the phone talks to this machine's IP, and only the
// deployment itself can answer whether Netlify's datacenter IP is accepted.

import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import handler from "./netlify/functions/ytm.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const port = Number(process.env.PORT) || 8890;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/api/ytm") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body }),
      });
      try {
        const response = await handler(request);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String(e?.message ?? e) }));
      }
      return;
    }

    let file = decodeURIComponent(url.pathname);
    if (file.endsWith("/")) file += "index.html";
    const full = path.resolve(root, "." + file);
    if (!full.startsWith(root + path.sep) && full !== root) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    try {
      const data = await readFile(full);
      res.writeHead(200, {
        "content-type": types[path.extname(full).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  })
  .listen(port, "0.0.0.0", () => {
    console.log(`http://localhost:${port}  (LAN: http://<this machine's IP>:${port})`);
    console.log(process.env.APP_KEY ? "APP_KEY is set" : "APP_KEY is not set (open)");
  });
