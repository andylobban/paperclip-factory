import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SERVICE_WORKER_BUILD_ID_PLACEHOLDER,
  deriveBuildIdFromEntryFileName,
  serviceWorkerBuildIdPlugin,
  stampServiceWorkerBuildId,
} from "./vite-sw-build-id";

const swSource = () =>
  `const BUILD_ID = "${SERVICE_WORKER_BUILD_ID_PLACEHOLDER}";\n` +
  "const CACHE_NAME = `paperclip-${BUILD_ID}`;\n";

describe("stampServiceWorkerBuildId", () => {
  it("replaces the placeholder with the build id and leaves no placeholder", () => {
    const out = stampServiceWorkerBuildId(swSource(), "index-abc123");
    expect(out).toContain("index-abc123");
    expect(out).not.toContain(SERVICE_WORKER_BUILD_ID_PLACEHOLDER);
  });

  it("produces different worker bytes for different build ids", () => {
    // This is the whole point: a new bundle -> a new sw.js -> a new worker ->
    // parked tabs reload. Identical build ids must stay byte-identical so the
    // worker does not churn when the app did not change.
    const a = stampServiceWorkerBuildId(swSource(), "index-aaaaaa");
    const b = stampServiceWorkerBuildId(swSource(), "index-bbbbbb");
    const again = stampServiceWorkerBuildId(swSource(), "index-aaaaaa");
    expect(a).not.toEqual(b);
    expect(a).toEqual(again);
  });

  it("throws when the placeholder is missing so a drifted worker fails the build", () => {
    expect(() => stampServiceWorkerBuildId("const CACHE_NAME = 'paperclip';", "x")).toThrow(
      /placeholder/,
    );
  });

  it("throws on an empty build id rather than shipping a nameless cache", () => {
    expect(() => stampServiceWorkerBuildId(swSource(), "")).toThrow();
  });
});

describe("deriveBuildIdFromEntryFileName", () => {
  it("uses the content-hashed entry file name", () => {
    expect(deriveBuildIdFromEntryFileName("assets/index-BHbrFFmp.js")).toBe("index-BHbrFFmp");
  });

  it("sanitizes characters that are unsafe in a cache name", () => {
    expect(deriveBuildIdFromEntryFileName("assets/index @weird!.js")).toBe("index--weird-");
  });
});

describe("serviceWorkerBuildIdPlugin", () => {
  it("sources an un-copied public worker and tolerates Vite closing the bundle twice", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-sw-build-"));
    const publicDir = path.join(root, "public");
    const outDir = path.join(root, "dist");
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(path.join(publicDir, "sw.js"), swSource());

    try {
      const plugin = serviceWorkerBuildIdPlugin();
      const configResolved = plugin.configResolved as unknown as (config: {
        build: { outDir: string };
        publicDir: string;
      }) => void;
      const generateBundle = plugin.generateBundle as unknown as (
        options: object,
        bundle: Record<string, { type: "chunk"; isEntry: boolean; fileName: string }>,
      ) => void;
      const closeBundle = plugin.closeBundle as unknown as () => void;

      configResolved({ build: { outDir }, publicDir });
      generateBundle({}, {
        entry: { type: "chunk", isEntry: true, fileName: "assets/index-abc123.js" },
      });
      closeBundle();
      expect(() => closeBundle()).not.toThrow();

      const output = fs.readFileSync(path.join(outDir, "sw.js"), "utf8");
      expect(output).toContain("index-abc123");
      expect(output).not.toContain(SERVICE_WORKER_BUILD_ID_PLACEHOLDER);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("public/sw.js contract", () => {
  it("still contains the placeholder the plugin rewrites", () => {
    const swPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../public/sw.js",
    );
    const source = fs.readFileSync(swPath, "utf8");
    expect(source).toContain(SERVICE_WORKER_BUILD_ID_PLACEHOLDER);
  });
});
