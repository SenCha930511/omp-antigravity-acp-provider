import fs from "node:fs";
import { writeJsonAtomic } from "./fs-atomic.ts";
import { resolveContextOptions, type ContextSettings, type ResolvedContextOptions } from "./context-settings.ts";
import { EFFORTS, projectCatalog, readModels, type AdvertisedModel, type PublicCatalogModel } from "./model-catalog.ts";
import { officialApiCost } from "./pricing.ts";
import { advertisedRecord, choices, selector } from "./selectors.ts";
import { TierConnection, authenticateForCredential, usableApiKey } from "./runtime.mjs";
import type { SessionCleanup } from "./session-cleanup.ts";

export interface ConfiguredCatalogModel extends PublicCatalogModel {
  ompContextPolicy: ResolvedContextOptions;
}

export class CatalogStore {
  readonly upstreamModels = new Map<string, ConfiguredCatalogModel>();
  currentModels: ConfiguredCatalogModel[] = [];
  private sourceModels: PublicCatalogModel[] = [];
  // False while only the adapter's offline fallback is loaded. A real cache or
  // successful discovery flips this so inference does not keep re-discovering.
  private upstreamKnown = false;
  private dynamicCache?: { stamp?: string; settings: string; models: ConfiguredCatalogModel[] };
  private readonly discoveries = new Map<string, Promise<AdvertisedModel[]>>();
  private readonly refreshes = new Map<string, Promise<ConfiguredCatalogModel[]>>();
  private latestSettings?: ContextSettings;

  constructor(
    private readonly cachePath: string,
    private readonly cleanup: SessionCleanup,
    private readonly prepareRuntime: () => Promise<void>,
    private readonly fallbackModels: () => PublicCatalogModel[],
    private readonly requireAuth: (apiKey?: string) => Promise<void> = async () => {},
    private readonly createConnection: (options: ConstructorParameters<typeof TierConnection>[0]) => TierConnection =
      options => new TierConnection(options),
  ) {}

  get hasUpstreamCatalog(): boolean {
    return this.upstreamKnown;
  }

  projectWithSettings(models: PublicCatalogModel[], settings: ContextSettings, upstreamKnown = true): ConfiguredCatalogModel[] {
    const projected = this.project(models, settings);
    this.install(projected, models, settings, upstreamKnown);
    return projected;
  }

  private project(models: PublicCatalogModel[], settings: ContextSettings): ConfiguredCatalogModel[] {
    return models.map(source => {
      const limits = resolveContextOptions(source, settings);
      const model: ConfiguredCatalogModel = {
        ...source,
        contextWindow: limits.contextWindow,
        maxTokens: limits.maxTokens,
        ompContextPolicy: limits,
        cost: officialApiCost(source.id) ?? source.cost,
      };
      const efforts = EFFORTS.filter(effort => model.thinkingLevelMap?.[effort]);
      if (efforts.length && !model.thinking) {
        model.thinking = { mode: "effort", efforts, defaultLevel: efforts.includes("high") ? "high" : efforts[0]! };
      }
      return model;
    });
  }

  private install(
    models: ConfiguredCatalogModel[],
    sources: PublicCatalogModel[],
    settings: ContextSettings,
    upstreamKnown = true,
  ) {
    // Publish only after every model validates. Preserve source limits so a
    // removed override does not inherit the previous projected values.
    this.sourceModels = sources;
    this.latestSettings = settings;
    this.currentModels = models;
    this.dynamicCache = undefined;
    this.upstreamKnown = upstreamKnown;
    this.upstreamModels.clear();
    // Offline fallbacks stay selectable but are not proof that the server
    // advertises them; the first inference must still discover the real catalog.
    if (upstreamKnown) for (const model of models) this.upstreamModels.set(model.id, model);
  }

  readCachedCatalog(): AdvertisedModel[] {
    try {
      const cache = JSON.parse(fs.readFileSync(this.cachePath, "utf8")) as { schemaVersion?: unknown; models?: unknown };
      if (cache.schemaVersion !== 1 && cache.schemaVersion !== 2) return [];
      return readModels(cache.models);
    } catch { return []; }
  }

  loadInitialOrCached(settings: ContextSettings): ConfiguredCatalogModel[] {
    const cached = this.readCachedCatalog();
    const base = cached.length ? projectCatalog(cached) : this.fallbackModels();
    this.currentModels = this.projectWithSettings(base, settings, cached.length > 0);
    return this.currentModels;
  }

  // OMP's host may call fetchDynamicModels on every startup pass; stat-based
  // reuse avoids re-reading and re-projecting an unchanged cache file.
  getDynamicModels(settings: ContextSettings): ConfiguredCatalogModel[] {
    let stamp: string | undefined;
    try {
      const stat = fs.statSync(this.cachePath);
      stamp = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    } catch { /* Missing or unreadable cache: fall through to a fresh read. */ }
    const settingsKey = JSON.stringify(settings);
    if (this.dynamicCache && this.dynamicCache.stamp === stamp && this.dynamicCache.settings === settingsKey) {
      return this.dynamicCache.models;
    }
    const cached = this.readCachedCatalog();
    const base = cached.length ? projectCatalog(cached) : this.fallbackModels();
    const models = this.projectWithSettings(base, settings, cached.length > 0);
    this.dynamicCache = { stamp, settings: settingsKey, models };
    return models;
  }

  reconfigure(settings: ContextSettings): ConfiguredCatalogModel[] {
    return this.projectWithSettings(this.sourceModels, settings, this.upstreamKnown);
  }

  async discoverModels(apiKey?: string): Promise<AdvertisedModel[]> {
    const key = usableApiKey(apiKey) ?? "";
    const existing = this.discoveries.get(key);
    if (existing) return existing;
    const pending = this.discoverOnce(apiKey);
    this.discoveries.set(key, pending);
    try { return await pending; }
    finally { if (this.discoveries.get(key) === pending) this.discoveries.delete(key); }
  }
  private async discoverOnce(apiKey?: string): Promise<AdvertisedModel[]> {
    await this.requireAuth(apiKey);
    await this.prepareRuntime();
    const connection = this.createConnection({ cwd: process.cwd(), ompCleanup: this.cleanup });
    let discoveredSession: string | undefined;
    try {
      const initialize = await connection.initialize();
      // An OMP-stored key is validated by the server's own API-key method; the
      // managed marker and absent keys keep the local-login fallback.
      await authenticateForCredential(connection, initialize, apiKey);
      const session = await connection.newSession(process.cwd());
      discoveredSession = session.sessionId;
      const modern = choices(selector(session, "model"));
      if (modern.length) {
        const models: AdvertisedModel[] = [];
        for (const option of modern) {
          // Model changes can alter reasoning choices; inspect each model's
          // confirmed configuration rather than sharing one global tier list.
          try {
            await connection.setModel(session.sessionId, option.value);
            models.push(advertisedRecord(connection.getSessionState(session.sessionId), option.value, option.name));
          } catch {
            // An advertised preview/retired model can reject selection without
            // making the remaining models unusable.
          }
        }
        if (!models.length) throw new Error("Antigravity advertised models but none could be selected");
        return models;
      }
      const models = readModels(session.models?.availableModels);
      if (!models.length) throw new Error("Antigravity did not advertise any models");
      return models;
    } finally {
      try { if (discoveredSession) await connection.discardSession(discoveredSession); }
      finally { await connection.close(); }
    }
  }

  async refresh(settings: ContextSettings, apiKey?: string): Promise<ConfiguredCatalogModel[]> {
    this.latestSettings = settings;
    const key = usableApiKey(apiKey) ?? "";
    const existing = this.refreshes.get(key);
    if (existing) return existing;
    const pending = this.refreshOnce(apiKey);
    this.refreshes.set(key, pending);
    try { return await pending; }
    finally { if (this.refreshes.get(key) === pending) this.refreshes.delete(key); }
  }
  private async refreshOnce(apiKey?: string): Promise<ConfiguredCatalogModel[]> {
    const models = await this.discoverModels(apiKey);
    const sources = projectCatalog(models);
    const settings = this.latestSettings ?? { defaults: {}, models: {} };
    const registered = this.project(sources, settings);
    writeJsonAtomic(this.cachePath, {
      schemaVersion: 2,
      discoveredAt: new Date().toISOString(),
      models,
    });
    // Discovery succeeded, so this catalog is now upstream-verified even when
    // the cache write above is the only persistence step.
    this.install(registered, sources, settings, true);
    return registered;
  }
}
