// Linux Secret Service (secret-tool) behavior for the future
// extension/secret-service.ts. Every runner is a synthetic in-memory stub, so
// these tests never invoke the real secret-tool or touch a real keyring.
import assert from "node:assert/strict";
import test from "node:test";

import { createSecretService, runSecretTool } from "../extension/secret-service.ts";

const LOOKUP = ["lookup", "service", "gemini", "username", "antigravity"];
const CLEAR = ["clear", "service", "gemini", "username", "antigravity"];
const SYNTHETIC_SECRET = "synthetic-secret-value";
const RAW_FAILURE = "synthetic raw failure detail";

interface ExecFailure extends Error {
	code?: number | string | null;
	killed?: boolean;
	signal?: string | null;
	stdout?: string;
	stderr?: string;
}

function failure(detail: Omit<ExecFailure, "name" | "message">): ExecFailure {
	return Object.assign(new Error(RAW_FAILURE), detail);
}

test("linux lookup and clear use the gemini/antigravity secret-tool argv", async () => {
	const calls: string[][] = [];
	const service = createSecretService(async (args) => {
		calls.push(args);
		return args[0] === "lookup" ? `${SYNTHETIC_SECRET}\n` : "";
	}, "linux");

	assert.equal(await service.present(), true);
	assert.equal(await service.remove(), true);
	assert.deepEqual(calls, [LOOKUP, CLEAR]);
});

test("only non-whitespace lookup output is a present item and nothing is cached", async () => {
	let output = "";
	const service = createSecretService(async () => output, "linux");
	for (const empty of ["", " \n\t"]) {
		output = empty;
		assert.equal(await service.present(), false, `lookup output ${JSON.stringify(empty)} is not a credential`);
	}
	for (const present of [SYNTHETIC_SECRET, `  ${SYNTHETIC_SECRET}  \n`]) {
		output = present;
		assert.equal(await service.present(), true);
	}
	output = " \n";
	assert.equal(await service.present(), false, "an earlier present result must not persist");
});

test("non-linux platforms never run the helper", async () => {
	let calls = 0;
	for (const platform of ["darwin", "win32"] as const) {
		const service = createSecretService(async () => {
			calls++;
			return SYNTHETIC_SECRET;
		}, platform);
		assert.equal(await service.present(), undefined);
		assert.equal(await service.remove(), undefined);
	}
	assert.equal(calls, 0);
});

test("confirmed missing is separate from unavailable and unexpected failures", async () => {
	const missing = createSecretService(async () => {
		throw failure({ code: 1, killed: false, signal: null, stdout: "", stderr: "" });
	}, "linux");
	assert.equal(await missing.present(), false);

	const unavailable = [
		failure({ code: 1, killed: false, signal: null, stdout: SYNTHETIC_SECRET, stderr: "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY" }),
		failure({ code: 1, killed: false, signal: null, stdout: SYNTHETIC_SECRET, stderr: "Error calling StartServiceByName for org.freedesktop.secrets" }),
		failure({ code: "ETIMEDOUT", killed: true, signal: "SIGTERM", stdout: SYNTHETIC_SECRET, stderr: RAW_FAILURE }),
		failure({ code: null, killed: true, signal: "SIGKILL", stdout: SYNTHETIC_SECRET, stderr: RAW_FAILURE }),
		failure({ code: "ENOENT", killed: false, signal: null, stdout: "", stderr: RAW_FAILURE }),
	];
	for (const error of unavailable) {
		const service = createSecretService(async () => { throw error; }, "linux");
		assert.equal(await service.present(), undefined, "an unavailable keyring is not a confirmed empty keyring");
	}

	const failureError = failure({ code: 2, killed: false, signal: null, stdout: SYNTHETIC_SECRET, stderr: RAW_FAILURE });
	const failing = createSecretService(async () => { throw failureError; }, "linux");
	await assert.rejects(failing.present(), (thrown: unknown) => {
		assert.ok(thrown instanceof Error);
		assert.ok(thrown.message.length > 0);
		assert.ok(!thrown.message.includes(RAW_FAILURE));
		assert.ok(!thrown.message.includes(SYNTHETIC_SECRET));
		return true;
	});
});

test("clear succeeds, a bare exit 1 is already absent, other failures are fixed", async () => {
	const calls: string[][] = [];
	const service = createSecretService(async (args) => {
		calls.push(args);
		return "";
	}, "linux");
	assert.equal(await service.remove(), true);
	assert.deepEqual(calls, [CLEAR]);

	const absent = createSecretService(async () => {
		throw failure({ code: 1, killed: false, signal: null, stdout: "", stderr: "" });
	}, "linux");
	assert.equal(await absent.remove(), false);

	const unavailable = createSecretService(async () => {
		throw failure({ code: 1, killed: false, signal: null, stdout: "", stderr: "keyring is locked" });
	}, "linux");
	assert.equal(await unavailable.remove(), undefined, "an unavailable keyring cannot be certified as removed");

	const unavailableForCleanup = createSecretService(async () => {
		throw failure({ code: "ETIMEDOUT", killed: true, signal: "SIGTERM", stdout: SYNTHETIC_SECRET, stderr: RAW_FAILURE });
	}, "linux");
	assert.equal(await unavailableForCleanup.remove(), undefined, "an interrupted clear cannot certify a deletion");

	const messages = new Set<string>();
	for (const error of [
		failure({ code: 2, killed: false, signal: null, stdout: SYNTHETIC_SECRET, stderr: RAW_FAILURE }),
	]) {
		const failing = createSecretService(async () => { throw error; }, "linux");
		await assert.rejects(failing.remove(), (thrown: unknown) => {
			assert.ok(thrown instanceof Error);
			assert.ok(!thrown.message.includes(RAW_FAILURE));
			assert.ok(!thrown.message.includes(SYNTHETIC_SECRET));
			messages.add(thrown.message);
			return true;
		});
	}
	assert.equal(messages.size, 1, "remove failures must share one credential-free message");
});

test("a killed clear is unavailable rather than removed", async () => {
	const service = createSecretService(async () => {
		throw failure({ code: null, killed: true, signal: "SIGKILL", stdout: SYNTHETIC_SECRET, stderr: RAW_FAILURE });
	}, "linux");
	assert.equal(await service.remove(), undefined);
});

test("runSecretTool forwards argv through execFile without a shell", async () => {
	const script = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
	const forwarded = ["service", "gemini; echo injected", "$(echo injected)", "`echo injected`", "username antigravity"];
	const stdout = await runSecretTool(["-e", script, ...forwarded], process.execPath);
	assert.deepEqual(JSON.parse(stdout), forwarded);
});

test("captured lookup output stays in memory and is never logged", async () => {
	const consoleCalls: unknown[][] = [];
	const writes: string[] = [];
	const methods = ["log", "info", "warn", "error", "debug"] as const;
	const originalConsole = new Map(methods.map(method => [method, console[method]]));
	const originalStdout = process.stdout.write;
	const originalStderr = process.stderr.write;
	const capture = (chunk: unknown, ...rest: unknown[]): boolean => {
		writes.push(typeof chunk === "string" ? chunk : String(chunk));
		const callback = rest.find(value => typeof value === "function") as (() => void) | undefined;
		callback?.();
		return true;
	};

	for (const method of methods) console[method] = (...args: unknown[]) => { consoleCalls.push(args); };
	process.stdout.write = capture as typeof process.stdout.write;
	process.stderr.write = capture as typeof process.stderr.write;
	try {
		const service = createSecretService(async (args) => args[0] === "lookup" ? `${SYNTHETIC_SECRET}\n` : "", "linux");
		assert.equal(await service.present(), true);
		assert.equal(await service.remove(), true);
		assert.ok(!JSON.stringify(service).includes(SYNTHETIC_SECRET), "the service must not retain captured stdout");
	} finally {
		for (const method of methods) console[method] = originalConsole.get(method)!;
		process.stdout.write = originalStdout;
		process.stderr.write = originalStderr;
	}

	assert.deepEqual(consoleCalls, []);
	assert.ok(!writes.join("").includes(SYNTHETIC_SECRET), "captured stdout must not reach logs or inherited output");
});
