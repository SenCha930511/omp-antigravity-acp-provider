import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAuthorization } from "../extension/runtime/acp/headless-oauth.ts";

test("accepts the standard Google OAuth endpoint", () => {
  const url = "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=123.apps.googleusercontent.com&redirect_uri=http%3A%2F%2Flocalhost%3A51797%2Fauth%2Fcallback&response_type=code&state=TESTSTATE123";
  const result = parseAuthorization(url);
  assert.equal(result.url, url);
  assert.equal(result.state, "TESTSTATE123");
  assert.equal(result.redirectUrl.origin, "http://localhost:51797");
  assert.equal(result.redirectUrl.pathname, "/auth/callback");
});

test("accepts the Google OAuth v2 endpoint", () => {
  const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=123&redirect_uri=http%3A%2F%2F127.0.0.1%3A8080%2Fcallback&state=ABC456";
  const result = parseAuthorization(url);
  assert.equal(result.url, url);
  assert.equal(result.state, "ABC456");
  assert.equal(result.redirectUrl.origin, "http://127.0.0.1:8080");
});

test("accepts the Google sign-in OAuth endpoint", () => {
  const url = "https://accounts.google.com/signin/oauth?client_id=123&redirect_uri=http%3A%2F%2Flocalhost%3A7777%2Fcallback&state=SIGNIN";
  const result = parseAuthorization(url);
  assert.equal(result.url, url);
  assert.equal(result.state, "SIGNIN");
  assert.equal(result.redirectUrl.origin, "http://localhost:7777");
});

test("unwraps AccountChooser with a valid Google continuation", () => {
  const inner = "https://accounts.google.com/o/oauth2/auth?client_id=123&redirect_uri=http%3A%2F%2Flocalhost%3A9000%2Fcallback&state=XYZ";
  const outer = `https://accounts.google.com/AccountChooser?continue=${encodeURIComponent(inner)}`;
  const result = parseAuthorization(outer);
  assert.equal(result.url, outer);
  assert.equal(result.state, "XYZ");
  assert.equal(result.redirectUrl.origin, "http://localhost:9000");
});

test("rejects a non-Google host", () => {
  assert.throws(
    () => parseAuthorization("https://evil.com/o/oauth2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8080&state=123"),
    /unexpected OAuth authorization URL/,
  );
});

test("rejects an unexpected path on Google", () => {
  assert.throws(
    () => parseAuthorization("https://accounts.google.com/invalid/path?redirect_uri=http%3A%2F%2Flocalhost%3A8080&state=123"),
    /unexpected OAuth authorization URL/,
  );
});

test("rejects AccountChooser with a non-Google continuation", () => {
  const inner = "https://evil.com/o/oauth2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8080&state=123";
  const outer = `https://accounts.google.com/AccountChooser?continue=${encodeURIComponent(inner)}`;
  assert.throws(() => parseAuthorization(outer), /unexpected OAuth authorization URL/);
});

test("rejects a non-loopback redirect URI", () => {
  assert.throws(
    () => parseAuthorization("https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&state=123"),
    /not a valid loopback URL/,
  );
});

test("rejects missing redirect_uri or state", () => {
  assert.throws(
    () => parseAuthorization("https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8080"),
    /missing redirect or state data/,
  );
  assert.throws(
    () => parseAuthorization("https://accounts.google.com/o/oauth2/auth?state=123"),
    /missing redirect or state data/,
  );
});

test("rejects a malformed URL", () => {
  assert.throws(() => parseAuthorization("not-a-valid-url"), /invalid OAuth authorization URL/);
});
