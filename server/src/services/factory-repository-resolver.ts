import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { projectWorkspaces, projects } from "@paperclipai/db";
import {
  deriveProjectUrlKey,
  projectRepositoryResolutionPolicySchema,
  type ProjectRepository,
  type ProjectRepositoryResolutionPolicy,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { toolAccessService } from "./tool-access.js";

type RepositoryResolutionResult = {
  projectId: string;
  projectWorkspaceId: string;
  source: "existing" | "local" | "github" | "github_created";
  repositoryUrl: string | null;
};

type GitHubRepositoryResolver = (input: {
  companyId: string;
  userId: string | null;
  localTrusted?: boolean;
  owner: string;
  name: string;
  createIfMissing: boolean;
}) => Promise<(ProjectRepository & { factoryCreated?: boolean }) | null>;

function hasProjectRepositoryResolutionOverride(raw: unknown) {
  return Boolean(
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    Object.prototype.hasOwnProperty.call(raw, "repositoryResolution"),
  );
}

function configuredPolicy(
  raw: unknown,
  defaultPolicy: ProjectRepositoryResolutionPolicy | null,
): ProjectRepositoryResolutionPolicy | null {
  const projectPolicy = parseProjectExecutionWorkspacePolicy(raw)?.repositoryResolution;
  const policy = hasProjectRepositoryResolutionOverride(raw) ? projectPolicy : defaultPolicy;
  if (!policy || policy.enabled !== true) return null;
  if (policy.version !== 1 || policy.visibility !== "private") {
    throw unprocessable("Project repository resolution policy is invalid", {
      code: "repository_resolution_policy_invalid",
    });
  }
  if (policy.createIfMissing && !policy.githubOwner) {
    throw unprocessable("Project repository resolution requires a GitHub owner before creation", {
      code: "repository_resolution_owner_required",
    });
  }
  return policy;
}

export function factoryRepositoryResolutionPolicyFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ProjectRepositoryResolutionPolicy | null {
  const owner = env.PAPERCLIP_FACTORY_REPOSITORY_GITHUB_OWNER?.trim() || null;
  const rawRoots = env.PAPERCLIP_FACTORY_REPOSITORY_LOCAL_ROOTS?.trim();
  let localSearchRoots: unknown = [];
  if (rawRoots) {
    try {
      localSearchRoots = JSON.parse(rawRoots);
    } catch {
      throw unprocessable(
        "PAPERCLIP_FACTORY_REPOSITORY_LOCAL_ROOTS must be a JSON array of absolute paths",
        { code: "repository_resolution_environment_invalid" },
      );
    }
  }
  if (!owner && Array.isArray(localSearchRoots) && localSearchRoots.length === 0) return null;
  const parsed = projectRepositoryResolutionPolicySchema.safeParse({
    version: 1,
    enabled: true,
    localSearchRoots,
    githubOwner: owner,
    createIfMissing: owner
      ? env.PAPERCLIP_FACTORY_REPOSITORY_CREATE_IF_MISSING !== "false"
      : false,
    visibility: "private",
  });
  if (!parsed.success) {
    throw unprocessable("Factory repository environment configuration is invalid", {
      code: "repository_resolution_environment_invalid",
    });
  }
  return parsed.data;
}

function isPathInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function isGitWorkingTree(candidate: string) {
  try {
    const dotGit = await stat(path.join(candidate, ".git"));
    return dotGit.isDirectory() || dotGit.isFile();
  } catch {
    return false;
  }
}

async function localRepositoryCandidate(roots: string[], repositoryName: string) {
  for (const configuredRoot of roots) {
    if (!path.isAbsolute(configuredRoot)) {
      throw unprocessable("Repository search roots must be absolute paths", {
        code: "repository_resolution_root_invalid",
      });
    }
    let root: string;
    try {
      root = await realpath(configuredRoot);
    } catch {
      continue;
    }
    const proposed = path.basename(root) === repositoryName
      ? root
      : path.join(root, repositoryName);
    let candidate: string;
    try {
      candidate = await realpath(proposed);
    } catch {
      continue;
    }
    if (candidate !== root && !isPathInside(root, candidate)) continue;
    if (await isGitWorkingTree(candidate)) return candidate;
  }
  return null;
}

async function localGitHubRemote(cwd: string) {
  try {
    let gitDir = path.join(cwd, ".git");
    const gitStat = await stat(gitDir);
    if (gitStat.isFile()) {
      const pointer = await readFile(gitDir, "utf8");
      const match = pointer.match(/^gitdir:\s*(.+)\s*$/im);
      if (!match?.[1]) return null;
      gitDir = path.resolve(cwd, match[1]);
    }
    const config = await readFile(path.join(gitDir, "config"), "utf8");
    const remote = config.match(/\[remote\s+"origin"\][\s\S]*?\n\s*url\s*=\s*([^\n]+)/i)?.[1]?.trim();
    if (!remote) return null;
    const https = remote.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i)?.[1]
      ?? remote.match(/^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i)?.[1];
    return https ? `https://github.com/${https}` : null;
  } catch {
    return null;
  }
}

export function factoryRepositoryResolver(
  db: Db,
  deps: {
    resolveGitHubRepository?: GitHubRepositoryResolver;
    defaultPolicy?: ProjectRepositoryResolutionPolicy | null;
  } = {},
) {
  const resolveGitHubRepository = deps.resolveGitHubRepository
    ?? ((input) => toolAccessService(db).resolveOrCreatePrivateProjectRepository(input));

  async function existingWorkspace(
    database: Db,
    companyId: string,
    projectId: string,
  ) {
    return database
      .select()
      .from(projectWorkspaces)
      .where(and(
        eq(projectWorkspaces.companyId, companyId),
        eq(projectWorkspaces.projectId, projectId),
      ))
      .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
      .then((rows) => rows.find((row) => Boolean(row.cwd || row.repoUrl)) ?? null);
  }

  async function registerWorkspace(database: Db, input: {
    companyId: string;
    projectId: string;
    name: string;
    cwd?: string | null;
    repository?: (ProjectRepository & { factoryCreated?: boolean }) | null;
    source: RepositoryResolutionResult["source"];
  }): Promise<RepositoryResolutionResult> {
    const current = await database
      .select()
      .from(projectWorkspaces)
      .where(and(
        eq(projectWorkspaces.companyId, input.companyId),
        eq(projectWorkspaces.projectId, input.projectId),
      ))
      .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
      .then((rows) => rows.find((row) => Boolean(row.cwd || row.repoUrl)) ?? null);
    if (current) {
      return {
        projectId: input.projectId,
        projectWorkspaceId: current.id,
        source: "existing" as const,
        repositoryUrl: current.repoUrl,
      };
    }
    const [workspace] = await database.insert(projectWorkspaces).values({
      companyId: input.companyId,
      projectId: input.projectId,
      name: input.repository?.fullName ?? input.name,
      sourceType: input.cwd ? "local_path" : "git_repo",
      cwd: input.cwd ?? null,
      repoUrl: input.repository?.url ?? (input.cwd ? await localGitHubRemote(input.cwd) : null),
      remoteProvider: input.repository ? "github" : null,
      metadata: input.repository
        ? {
            githubRepositoryId: input.repository.id,
            repositoryVisibility: input.repository.private === true ? "private" : "public",
            provisionedBy: "factory_repository_resolver",
          }
        : { discoveredBy: "factory_repository_resolver" },
      isPrimary: true,
    }).returning();
    await database.update(projects).set({
      executionWorkspacePolicy: sql`jsonb_set(
        coalesce(${projects.executionWorkspacePolicy}, '{}'::jsonb),
        '{defaultProjectWorkspaceId}',
        to_jsonb(${workspace!.id}::text),
        true
      )`,
      updatedAt: new Date(),
    }).where(and(eq(projects.companyId, input.companyId), eq(projects.id, input.projectId)));
    return {
      projectId: input.projectId,
      projectWorkspaceId: workspace!.id,
      source: input.source,
      repositoryUrl: workspace!.repoUrl,
    };
  }

  return {
    resolveForProject: async (input: {
      companyId: string;
      projectId: string;
      responsibleUserId: string | null;
      localTrusted?: boolean;
    }): Promise<RepositoryResolutionResult | null> => {
      const project = await db
        .select({
          id: projects.id,
          name: projects.name,
          executionWorkspacePolicy: projects.executionWorkspacePolicy,
        })
        .from(projects)
        .where(and(eq(projects.companyId, input.companyId), eq(projects.id, input.projectId)))
        .then((rows) => rows[0] ?? null);
      if (!project) throw notFound("Project not found");
      const policy = configuredPolicy(
        project.executionWorkspacePolicy,
        deps.defaultPolicy ?? null,
      );
      if (!policy) return null;

      const existing = await existingWorkspace(db, input.companyId, input.projectId);
      if (existing) {
        return {
          projectId: input.projectId,
          projectWorkspaceId: existing.id,
          source: "existing",
          repositoryUrl: existing.repoUrl,
        };
      }

      const repositoryName = policy.repositoryName ?? deriveProjectUrlKey(project.name, project.id);
      // The project-scoped database lock intentionally spans the bounded remote
      // lookup/create. It is the cross-process idempotency boundary: after the
      // winner registers a workspace, every waiter rechecks under the lock and
      // returns that workspace without issuing a second GitHub create.
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`factory-repository:${input.projectId}`}, 0))`);
        const lockedDb = tx as unknown as Db;
        // Lock the durable project row as well as the advisory key. The row
        // lock is the cross-process ownership record for the remote creation
        // interval; a waiter cannot issue its own provider create until it has
        // re-read the workspace state after the winner commits.
        await tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.companyId, input.companyId), eq(projects.id, input.projectId)))
          .for("update");
        const current = await existingWorkspace(lockedDb, input.companyId, input.projectId);
        if (current) {
          return {
            projectId: input.projectId,
            projectWorkspaceId: current.id,
            source: "existing" as const,
            repositoryUrl: current.repoUrl,
          };
        }

        const local = await localRepositoryCandidate(policy.localSearchRoots, repositoryName);
        if (local) {
          return registerWorkspace(lockedDb, {
            companyId: input.companyId,
            projectId: input.projectId,
            name: repositoryName,
            cwd: local,
            source: "local",
          });
        }
        if (policy.githubOwner) {
          const repository = await resolveGitHubRepository({
            companyId: input.companyId,
            userId: input.responsibleUserId,
            localTrusted: input.localTrusted,
            owner: policy.githubOwner,
            name: repositoryName,
            createIfMissing: policy.createIfMissing,
          });
          if (!repository) {
            throw conflict("No local or authorized GitHub repository matches this project", {
              code: "repository_resolution_failed",
              projectId: input.projectId,
              repository: `${policy.githubOwner}/${repositoryName}`,
            });
          }
          return registerWorkspace(lockedDb, {
            companyId: input.companyId,
            projectId: input.projectId,
            name: repositoryName,
            repository,
            source: repository.factoryCreated === true ? "github_created" : "github",
          });
        }
        throw conflict("No local repository was found and no GitHub owner is configured", {
          code: "repository_resolution_failed",
          projectId: input.projectId,
          repository: repositoryName,
        });
      });

      if (result.source !== "existing") await logActivity(db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: "factory-repository-resolver",
        action: "project.repository_resolved",
        entityType: "project",
        entityId: input.projectId,
        responsibleUserIdOverride: input.responsibleUserId,
        details: {
          source: result.source,
          projectWorkspaceId: result.projectWorkspaceId,
          repositoryUrl: result.repositoryUrl,
          visibility: result.source === "github_created" ? "private" : null,
        },
      });
      return result;
    },
  };
}

export type FactoryRepositoryResolver = ReturnType<typeof factoryRepositoryResolver>;
