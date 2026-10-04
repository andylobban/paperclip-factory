import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, projectWorkspaces, projects } from "@paperclipai/db";
import { projectExecutionWorkspacePolicySchema } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  factoryRepositoryResolutionPolicyFromEnvironment,
  factoryRepositoryResolver,
} from "../services/factory-repository-resolver.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("repository resolution policy", () => {
  it("defaults factory-created repositories to private and rejects public creation", () => {
    const parsed = projectExecutionWorkspacePolicySchema.parse({
      enabled: true,
      repositoryResolution: {
        enabled: true,
        githubOwner: "example",
        createIfMissing: true,
      },
    });
    expect(parsed.repositoryResolution?.visibility).toBe("private");
    expect(() => projectExecutionWorkspacePolicySchema.parse({
      enabled: true,
      repositoryResolution: {
        enabled: true,
        githubOwner: "example",
        createIfMissing: true,
        visibility: "public",
      },
    })).toThrow();
  });

  it("builds an upstream-safe private factory default from environment configuration", () => {
    expect(factoryRepositoryResolutionPolicyFromEnvironment({
      PAPERCLIP_FACTORY_REPOSITORY_LOCAL_ROOTS: JSON.stringify(["/srv/source"]),
      PAPERCLIP_FACTORY_REPOSITORY_GITHUB_OWNER: "example-owner",
    })).toEqual({
      version: 1,
      enabled: true,
      localSearchRoots: ["/srv/source"],
      githubOwner: "example-owner",
      createIfMissing: true,
      visibility: "private",
    });
    expect(factoryRepositoryResolutionPolicyFromEnvironment({})).toBeNull();
  });
});

describeEmbeddedPostgres("factoryRepositoryResolver", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-repository-resolver-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedProject(repositoryResolution: Record<string, unknown>) {
    const [company] = await db.insert(companies).values({
      name: "Resolver Co",
      issuePrefix: `R${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const [project] = await db.insert(projects).values({
      companyId: company!.id,
      name: "Agent First UI",
      status: "in_progress",
      executionWorkspacePolicy: { enabled: true, repositoryResolution },
    }).returning();
    return { company: company!, project: project! };
  }

  it("registers an allowlisted local Git repository before consulting GitHub", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-local-repos-"));
    tempRoots.push(root);
    const repositoryPath = path.join(root, "agent-first-ui");
    await mkdir(path.join(repositoryPath, ".git"), { recursive: true });
    const { company, project } = await seedProject({
      version: 1,
      enabled: true,
      localSearchRoots: [root],
      repositoryName: "agent-first-ui",
      createIfMissing: true,
      githubOwner: "example",
      visibility: "private",
    });
    const github = vi.fn();
    const resolver = factoryRepositoryResolver(db, { resolveGitHubRepository: github });

    const result = await resolver.resolveForProject({
      companyId: company.id,
      projectId: project.id,
      responsibleUserId: null,
    });

    expect(result).toMatchObject({ source: "local", repositoryUrl: null });
    expect(github).not.toHaveBeenCalled();
    const [workspace] = await db.select().from(projectWorkspaces);
    expect(workspace).toMatchObject({ cwd: repositoryPath, isPrimary: true });
  });

  it("falls back to GitHub creation and registers the private repository", async () => {
    const { company, project } = await seedProject({
      version: 1,
      enabled: true,
      localSearchRoots: [],
      repositoryName: "agent-first-ui",
      createIfMissing: true,
      githubOwner: "example",
      visibility: "private",
    });
    const github = vi.fn().mockResolvedValue({
      id: "42",
      fullName: "example/agent-first-ui",
      url: "https://github.com/example/agent-first-ui",
      private: true,
      connections: ["GitHub"],
      factoryCreated: true,
    });
    const resolver = factoryRepositoryResolver(db, { resolveGitHubRepository: github });

    const result = await resolver.resolveForProject({
      companyId: company.id,
      projectId: project.id,
      responsibleUserId: "owner-user",
    });

    expect(github).toHaveBeenCalledWith(expect.objectContaining({
      owner: "example",
      name: "agent-first-ui",
      createIfMissing: true,
    }));
    expect(result).toMatchObject({
      source: "github_created",
      repositoryUrl: "https://github.com/example/agent-first-ui",
    });
    const [workspace] = await db.select().from(projectWorkspaces);
    expect(workspace).toMatchObject({
      repoUrl: "https://github.com/example/agent-first-ui",
      sourceType: "git_repo",
      metadata: expect.objectContaining({ repositoryVisibility: "private" }),
    });
  });

  it("rejects a symlinked local candidate that escapes its configured root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-contained-repos-"));
    const outside = await mkdtemp(path.join(tmpdir(), "paperclip-outside-repo-"));
    tempRoots.push(root, outside);
    await mkdir(path.join(outside, ".git"));
    await symlink(outside, path.join(root, "agent-first-ui"));
    const { company, project } = await seedProject({
      version: 1,
      enabled: true,
      localSearchRoots: [root],
      repositoryName: "agent-first-ui",
      createIfMissing: false,
      githubOwner: "example",
      visibility: "private",
    });
    const github = vi.fn().mockResolvedValue({
      id: "43",
      fullName: "example/agent-first-ui",
      url: "https://github.com/example/agent-first-ui",
      private: true,
      connections: ["GitHub"],
    });

    const result = await factoryRepositoryResolver(db, { resolveGitHubRepository: github })
      .resolveForProject({
        companyId: company.id,
        projectId: project.id,
        responsibleUserId: null,
      });

    expect(github).toHaveBeenCalledOnce();
    expect(result?.source).toBe("github");
    const [workspace] = await db.select().from(projectWorkspaces);
    expect(workspace!.cwd).toBeNull();
  });
});
