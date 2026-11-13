import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSensitiveText } from "../extension/redact.ts";

const SENSITIVE_QUERY_KEYS = [
  "access_token",
  "refresh_token",
  "client_secret",
  "id_token",
  "api_key",
  "password",
  "code",
  "code_challenge",
  "code_verifier",
  "state",
  "token",
];

test("masks sensitive URL query values", () => {
  for (const key of SENSITIVE_QUERY_KEYS) {
    const url = `https://accounts.example.com/cb?${key}=sekrit-value&next=1`;
    assert.equal(redactSensitiveText(url), `https://accounts.example.com/cb?${key}=***&next=1`, key);
  }
});

test("masks URL userinfo credentials", () => {
  assert.equal(redactSensitiveText("https://user:pass@example.com/x"), "https://***@example.com/x");
  assert.equal(redactSensitiveText("postgres://dbuser:sekrit@db.internal:5432/app"), "postgres://***@db.internal:5432/app");
});

test("masks bearer tokens", () => {
  assert.equal(redactSensitiveText("Authorization: Bearer ya29.a0ARrdaM-9x"), "Authorization: Bearer ***");
});

test("masks bare and quoted OAuth pairs", () => {
  assert.equal(redactSensitiveText("code_challenge=KxYz123abc"), "code_challenge=***");
  assert.equal(redactSensitiveText("code_challenge: KxYz123abc"), "code_challenge: ***");
  assert.equal(redactSensitiveText('{"access_token":"ya29.xyz","ok":true}'), '{"access_token":"***","ok":true}');
  assert.equal(redactSensitiveText("'refresh_token': 'rt42'"), "'refresh_token': \"***\"");
});

test("keeps diagnostics with ambiguous keys intact", () => {
  assert.equal(redactSensitiveText("process exited with failure, exit code=1"), "process exited with failure, exit code=1");
  assert.equal(redactSensitiveText("state=running"), "state=running");
  assert.equal(redactSensitiveText("token expired, sign in again"), "token expired, sign in again");
});

test("empty and null input return an empty string", () => {
  assert.equal(redactSensitiveText(""), "");
  assert.equal(redactSensitiveText(null), "");
  assert.equal(redactSensitiveText(undefined), "");
});
