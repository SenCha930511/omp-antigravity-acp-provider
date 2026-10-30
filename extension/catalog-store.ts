import fs from "node:fs";
import { writeJsonAtomic } from "./fs-atomic.ts";
import { resolveContextOptions, type ContextSettings, type ResolvedContextOptions } from "./context-settings.ts";
import { EFFORTS, projectCatalog, readModels, type AdvertisedModel, type PublicCatalogModel } from "./model-catalog.ts";
import { officialApiCost } from "./pricing.ts";
import { advertisedRecord, choices, selector } from "./selectors.ts";
import { TierConnection } from "./runtime.mjs";
import type { SessionCleanup } from "./session-cleanup.ts";

export interface ConfiguredCatalogModel extends PublicCatalogModel {
  ompContextPolicy: ResolvedContextOptions;
}

export class CatalogStore {
  readonly upstreamModels = new Map<string, ConfiguredCatalogModel>();
  currentModels: ConfiguredCatalogModel[] = [];
  private sourceModels: PublicCatalogModel[] = [];
  private dynamicCache?: { stamp?: string; settings: string; models: ConfiguredCatalogModel[] };
  private discovery?: Promise<AdvertisedModel[]>;
  private refreshing?: Promise<ConfiguredCatalogModel[]>;
  private latestSettings?: ContextSettings;

  constructor(
    private readonly cachePath: string,
    private readonly cleanup: SessionCleanup,
    private readonly prepareRuntime: () => Promise<void>,
    private readonly fallbackModels: () => PublicCatalogModel[],
  ) {}

  projectWithSettings(models: PublicCatalogModel[], settings: ContextSettings): ConfiguredCatalogModel[] {
    const projected = this.project(models, settings);
    this.install(projected, models, settings);
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

  private install(models: ConfiguredCatalogModel[], sources: PublicCatalogModel[], settings: ContextSettings) {
    // Publish only after every model validates. Preserve source limits so a
    // removed override does not inherit the previous projected values.
    this.sourceModels = sources;
    this.latestSettings = settings;
    this.currentModels = models;
    this.dynamicCache = undefined;
    this.upstreamModels.clear();
    for (const model of models) this.upstreamModels.set(model.id, model);
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
    this.currentModels = this.projectWithSettings(base, settings);
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
    const models = this.projectWithSettings(base, settings);
    this.dynamicCache = { stamp, settings: settingsKey, models };
    return models;
  }

  reconfigure(settings: ContextSettings): ConfiguredCatalogModel[] {
    return this.projectWithSettings(this.sourceModels, settings);
  }

  async discoverModels(): Promise<AdvertisedModel[]> {
    if (this.discovery) return this.discovery;
    const pending = this.discoverOnce();
    this.discovery = pending;
    try { return await pending; }
    finally { if (this.discovery === pending) this.discovery = undefined; }
  }
  private async discoverOnce(): Promise<AdvertisedModel[]> {
    await this.prepareRuntime();
    const connection = new TierConnection({ cwd: process.cwd(), ompCleanup: this.cleanup });
    let discoveredSession: string | undefined;
    try {
      await connection.initialize();
      const session = await connection.newSession(process.cwd());
      discoveredSession = session.sessionId;
      const modern = choices(selector(session, "model"));
      if (modern.length) {
        const models: AdvertisedModel[] = [];
        for (const option of modern) {
          // Model changes can alter reasoning choices; inspect each model's
          // confirmed configuration rather than sharing one global tier list.
          await connection.setModel(session.sessionId, option.value);
          models.push(advertisedRecord(connection.getSessionState(session.sessionId), option.value, option.name));
        }
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

  async refresh(settings: ContextSettings): Promise<ConfiguredCatalogModel[]> {
    this.latestSettings = settings;
    if (this.refreshing) return this.refreshing;
    const pending = this.refreshOnce(); this.refreshing = pending;
    try { return await pending; } finally { if (this.refreshing === pending) this.refreshing = undefined; }
  }
  private async refreshOnce(): Promise<ConfiguredCatalogModel[]> {
    const models = await this.discoverModels();
    const sources = projectCatalog(models);
    const settings = this.latestSettings ?? { defaults: {}, models: {} };
    const registered = this.project(sources, settings);
    writeJsonAtomic(this.cachePath, {
      schemaVersion: 2,
      discoveredAt: new Date().toISOString(),
      models,
    });
    this.install(registered, sources, settings);
    return registered;
  }
}
