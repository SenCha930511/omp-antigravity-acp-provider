import type {
	Api,
	ApiStreamOptions,
	AssistantMessageEventStream,
	Context,
	TranscriptContext,
	Model,
	Provider,
	RefreshModelsContext,
	StreamOptions,
} from "@earendil-works/pi-ai";

import { hasAntigravityAuth } from "./acp/antigravity.ts";
import { type AntigravityModel, FALLBACK_MODELS, projectModels, PROVIDER_ID } from "./models.ts";
import { AntigravityRuntime, MANAGED_AUTH_MARKER, type OmpStreamOptions } from "./runtime.ts";

export interface AntigravityProvider extends Omit<Provider<"antigravity-acp">, "auth" | "streamSimple"> {
	auth: NonNullable<Provider<"antigravity-acp">["auth"]> & {
		oauth: {
			name: string;
			loginLabel: string;
			login(interaction: {
				signal?: AbortSignal;
				notify: (event: { type?: "progress" | "info"; message?: string; links?: Array<{ url: string; label?: string }> }) => void;
				prompt: (prompt: { type?: "secret" | "text" | "manual_code"; message: string; placeholder?: string; signal?: AbortSignal }) => Promise<string>;
			}): Promise<{
				type: "oauth";
				refresh: string;
				access: string;
				expires: number;
				[key: string]: unknown;
			}>;
			refresh<T>(credential: T, signal?: AbortSignal): Promise<T>;
			toAuth(): Promise<{ apiKey: string }>;
		};
	};
	streamSimple(
		model: AntigravityModel,
		context: Context | TranscriptContext,
		options?: OmpStreamOptions,
	): AssistantMessageEventStream;
}

export interface AntigravityProviderBundle {
	provider: AntigravityProvider;
	runtime: AntigravityRuntime;
}

export function createAntigravityProvider(runtime = new AntigravityRuntime()): AntigravityProviderBundle {
	let models = [...FALLBACK_MODELS];
	const provider: AntigravityProvider = {
		id: PROVIDER_ID,
		name: "Google Antigravity (ACP)",
		auth: {
			oauth: {
				name: "Google Antigravity (ACP)",
				loginLabel: "Sign in with Google",
				async login(interaction) {
					interaction.notify({ type: "progress", message: "Starting Antigravity Google login…" });
					await runtime.loginGoogle(
						interaction.signal,
						(message) => interaction.notify({ type: "progress", message }),
						{
							showAuthorizationUrl(url, instructions) {
								interaction.notify({
									type: "info",
									message: instructions,
									links: [{ url, label: "Google authorization" }],
								});
							},
							promptForCallback: (signal) =>
								interaction.prompt({
									type: "manual_code",
									message: "Paste the final localhost callback URL (or authorization code):",
									placeholder: "http://127.0.0.1:PORT/?state=…&code=…",
									signal,
								}),
						},
					);
					return {
						type: "oauth",
						// Pi needs a durable credential record so the provider stays visible;
						// the actual OAuth tokens remain owned by Google Antigravity.
						refresh: MANAGED_AUTH_MARKER,
						access: MANAGED_AUTH_MARKER,
						expires: Number.MAX_SAFE_INTEGER,
					};
				},
				async refresh<T>(credential: T) {
					return credential;
				},
				async toAuth() {
					return { apiKey: MANAGED_AUTH_MARKER };
				},
			},
			apiKey: {
				name: "Antigravity Gemini API key",
				async login(interaction) {
					const key = await interaction.prompt({
						type: "secret",
						message: "Gemini API key",
						placeholder: "AIza…",
					});
					if (!key.trim()) throw new Error("Gemini API key is required");
					interaction.notify({ type: "progress", message: "Verifying Gemini API key…" });
					await runtime.verifyApiKey(key.trim(), interaction.signal, (message) =>
						interaction.notify({ type: "progress", message }),
					);
					return { type: "api_key", key: key.trim() };
				},
				async check({ ctx, credential }) {
					if (credential?.key) return { type: "api_key", source: "Pi auth store" };
					if (await ctx.env("GEMINI_API_KEY")) return { type: "api_key", source: "GEMINI_API_KEY" };
					if (hasAntigravityAuth()) {
						return { type: "api_key", source: "Antigravity OAuth refresh token" };
					}
					return undefined;
				},
				async resolve({ ctx, credential }) {
					const key = credential?.key ?? (await ctx.env("GEMINI_API_KEY"));
					if (key) {
						return {
							auth: { apiKey: key },
							source: credential?.key ? "Pi auth store" : "GEMINI_API_KEY",
						};
					}
					if (hasAntigravityAuth()) {
						return { auth: { apiKey: MANAGED_AUTH_MARKER }, source: "Antigravity OAuth refresh token" };
					}
					return undefined;
				},
			},
		},
		getModels: () => models,
		async refreshModels(context: RefreshModelsContext) {
			if (!context.allowNetwork) return;
			const key =
				context.credential?.type === "api_key"
					? context.credential.key
					: context.credential?.type === "oauth"
						? MANAGED_AUTH_MARKER
						: undefined;
			let discovered;
			try {
				discovered = projectModels(await runtime.discoverModels(key, context.signal));
			} catch {
				// Startup refresh must not hide the conservative offline catalog when
				// authentication is absent, expired, or temporarily unavailable.
				return;
			}
			if (discovered.length === 0) return;
			await context.publish({
				update: () => {
					models = discovered;
				},
			});
		},
		stream(model, context, options: StreamOptions | undefined) {
			return stream(runtime, model, context, options);
		},
		streamSimple(model, context, options) {
			return stream(runtime, model, context, options);
		},
	};
	return { provider, runtime };
}

function stream(
	runtime: AntigravityRuntime,
	model: AntigravityModel,
	context: Context | TranscriptContext,
	options: OmpStreamOptions | undefined,
): AssistantMessageEventStream {
	return runtime.stream(model, context, options).stream;
}

export const ANTIGRAVITY_ACP_API = "antigravity-acp" satisfies Api;
