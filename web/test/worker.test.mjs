import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../dist/worker.js";

const get = (path, headers = {}, env = {}) =>
  worker.fetch(new Request("https://x" + path, { headers }), env);

test("serves the page, the stylesheet and the script", async () => {
  const page = await get("/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(await page.text(), /YTM Web/);

  assert.match((await get("/style.css")).headers.get("content-type"), /text\/css/);
  assert.match((await get("/app.js")).headers.get("content-type"), /javascript/);
});

test("noindex is on every file", async () => {
  assert.equal((await get("/")).headers.get("x-robots-tag"), "noindex, nofollow");
});

test("unknown paths are 404", async () => {
  assert.equal((await get("/nope")).status, 404);
});

test("the api rejects empty and malformed requests", async () => {
  assert.equal((await get("/api/ytm")).status, 400);
  const bad = await get("/api/ytm?action=resolve&id=short", { "x-app-key": "k" }, { APP_KEY: "k" });
  assert.equal(bad.status, 400);
});

test("APP_KEY guards the api", async () => {
  const denied = await get("/api/ytm?action=search&q=x", {}, { APP_KEY: "k" });
  assert.equal(denied.status, 401);
  const allowed = await get("/api/ytm?action=resolve&id=short", { "x-app-key": "k" }, { APP_KEY: "k" });
  assert.equal(allowed.status, 400);
});

test("without APP_KEY the api stays open", async () => {
  const res = await get("/api/ytm?action=resolve&id=short", {}, {});
  assert.equal(res.status, 400);
});
