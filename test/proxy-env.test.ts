import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureLoopbackBypass } from "../extension/proxy-env.ts";

test("merges loopback into both NO_PROXY and no_proxy when a proxy is set", () => {
  const env = ensureLoopbackBypass({ HTTP_PROXY: "http://127.0.0.1:7890" });
  assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1");
  assert.equal(env.no_proxy, "localhost,127.0.0.1,::1");
});

test("every proxy variable spelling triggers the bypass", () => {
  for (const name of ["http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    const env = ensureLoopbackBypass({ [name]: "socks5://127.0.0.1:7891" });
    assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1", name);
    assert.equal(env.no_proxy, "localhost,127.0.0.1,::1", name);
  }
});

test("preserves and dedupes existing exclusion entries", () => {
  const env = ensureLoopbackBypass({
    HTTPS_PROXY: "http://proxy.internal:3128",
    NO_PROXY: "localhost, corp.example.com ,127.0.0.1",
  });
  assert.equal(env.NO_PROXY, "localhost,corp.example.com,127.0.0.1,::1");
  assert.equal(env.no_proxy, "localhost,corp.example.com,127.0.0.1,::1");
});

test("inherits exclusion entries into the missing case", () => {
  const upper = ensureLoopbackBypass({ ALL_PROXY: "http://p:1", NO_PROXY: "corp.example.com" });
  assert.equal(upper.no_proxy, "corp.example.com,localhost,127.0.0.1,::1");
  const lower = ensureLoopbackBypass({ all_proxy: "http://p:1", no_proxy: "corp.example.com" });
  assert.equal(lower.NO_PROXY, "corp.example.com,localhost,127.0.0.1,::1");
});

test("returns the same env object when no proxy variables exist", () => {
  const env = { PATH: "/usr/bin", NO_PROXY: "corp.example.com" };
  assert.equal(ensureLoopbackBypass(env), env);
});

test("empty proxy values count as unset", () => {
  const env = { HTTP_PROXY: "", https_proxy: "   " };
  assert.equal(ensureLoopbackBypass(env), env);
});
