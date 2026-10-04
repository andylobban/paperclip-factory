# Project source repositories

The Create project dialog accepts a name and optional GitHub repository selections.
It uses the same `RepositoryEditor` as project Configuration. Description remains
editable in Configuration. Status, goal links, and target dates remain supported by
the API but are omitted from creation; Status and Goals are omitted from Configuration.
Old Overview URLs and saved Overview preferences redirect to Configuration.

## API and persistence

- `GET /api/companies/:companyId/project-repositories` returns `repositories`,
  `connectionCount`, and `failedConnectionCount`. Repository IDs are GitHub's stable
  numeric IDs represented as strings. Results are deduplicated across accessible
  grants and sorted by full name. Connection labels are display provenance only.
- `POST /api/companies/:companyId/projects` accepts optional `repositoryIds`.
  The server resolves new selections through the caller's authorized GitHub grants
  before creating the project and all repository workspaces in a transaction.
  The existing `workspace` input remains supported; it cannot be combined with
  `repositoryIds`.
- `PUT /api/projects/:id/repositories` accepts the selected `repositoryIds` array.
  Accessible retained IDs refresh their canonical name and URL after renames or
  transfers; unavailable retained IDs keep their saved metadata.
  Replacement is transactional. Existing selections may be retained or removed even
  if their GitHub connection becomes unavailable. New identities require current
  access. Legacy URL workspaces are preserved, and matching legacy URLs are adopted
  without creating a duplicate workspace. Local/remote workspace locations survive
  detaching their repository.

No schema migration is required. Selected repositories are normal project workspaces
with `metadata.githubRepositoryId`. Existing manual `repoUrl` workspaces remain
editable through Configuration and the workspace API. One workspace remains primary.
Tasks materialize the other distinct repositories as editable checkouts inside their
workspace, including when no local folders are configured. Local execution and sandbox
staging use the same layout; sandbox restore preserves each repository's Git history.
See [Project Repository Checkouts](DEVELOPING.md#project-repository-checkouts) for paths,
ignore rules, and reuse behavior. Responsible-user credential rules still apply.
A repository selection never delegates credentials.

## Discovery and setup

The server checks company membership, grant ownership/status, and organization-grant
audiences before loading provider metadata. Connection managers receive no bypass to
another person's personal repositories. Managed GitHub grants refresh installation
access; PAT connections use paginated `/user/repos`. Provider failures are reported
without exposing provider error bodies or credential material. Successful connections
remain selectable when another connection fails.

`ConnectionSetupFlow` owns provider setup in both Apps and project dialogs. Task
intents retain their existing callback protocol. Standalone dialogs verify the saved
connection through the API after the sign-in popup returns to the instance. Project
name and repository drafts stay mounted across setup and cancellation.

## Factory repository resolution

Projects may opt into repository resolution through
`executionWorkspacePolicy.repositoryResolution`. Pipeline stage automation first
inherits project and workspace context from the case's linked origin issue. When the
project has no usable workspace, the resolver checks these sources in order:

1. the project's existing primary workspace;
2. `<localSearchRoot>/<repositoryName>` for each operator-configured absolute root;
3. the exact `<githubOwner>/<repositoryName>` visible through the responsible user's
   authorised GitHub grants;
4. private GitHub repository creation when `createIfMissing` is enabled.

The repository name defaults to the project's portable URL key. Account names,
repository names, and host paths are configuration, never product constants. Local
search is shallow and containment-checked after resolving symlinks; it does not scan
the host. Agent credentials cannot set this policy, and managed-sandbox-only instances
reject local search roots.

```json
{
  "enabled": true,
  "repositoryResolution": {
    "version": 1,
    "enabled": true,
    "localSearchRoots": ["/srv/source"],
    "githubOwner": "your-github-owner",
    "repositoryName": "optional-explicit-name",
    "createIfMissing": true,
    "visibility": "private"
  }
}
```

`visibility` is private-only in version 1 and defaults to `private`. The GitHub create
request also sends `private: true`, and the provider response must confirm that the new
repository is private before Paperclip registers it. A missing credential, insufficient
repository-creation permission, or unresolved repository fails the stage-entry preflight;
the case does not move into an implementation stage with an unusable task. Provider
credentials remain subject to company membership, grant ownership, audience, and
responsible-user rules. Concurrent registration is serialized per project.

Self-hosted operators can make the same policy the factory-wide default without
hard-coding deployment identity into Paperclip:

- `PAPERCLIP_FACTORY_REPOSITORY_LOCAL_ROOTS`: JSON array of absolute parent paths.
- `PAPERCLIP_FACTORY_REPOSITORY_GITHUB_OWNER`: GitHub user or organisation login.
- `PAPERCLIP_FACTORY_REPOSITORY_CREATE_IF_MISSING`: set to `false` to disable the
  final creation step; when an owner is configured it otherwise defaults to `true`.

The environment default is active only when at least one local root or GitHub owner is
configured. A project's explicit `repositoryResolution` block overrides it, including
`enabled: false` to opt that project out. Environment-driven creation remains
private-only.

This factory path is separate from `repositoryUrls` on the ordinary Create project API.
Those URLs continue to register existing repositories only and never create a remote.

## UI review and verification

`Proposals/Project repos` contains the reviewed states, including loading, failure,
empty search, disconnected GitHub, multiple repos, legacy URLs, forty selections,
mobile, and short viewports. The configuration story composes the production page
properties through an explicit repositories slot. Story setup and saves use fixtures.

- Shared visual control: `ui/src/components/RepositoryEditor.tsx`.
- Data and error handling: `ProjectRepositoryInput.tsx`.
- Configuration persistence and legacy editing: `ProjectRepositories.tsx` and
  `LegacyProjectRepository.tsx`.
- Production dialog: `NewProjectDialog.tsx`.
- Server tests: `project-repositories.test.ts` and
  `project-repositories-persistence.test.ts`.
- Browser acceptance: `tests/e2e/project-repositories.spec.ts`.

The browser suite uses a real temporary server and database. It verifies creation,
forty persisted repos, mobile scrolling, removal/save/reload, legacy URL editing,
and rejection without a partial project. Provider discovery is simulated in the
picker rejection test. GitHub network and popup behavior use deterministic fixtures
in integration/component tests; the suite does not authorize a real GitHub account.
