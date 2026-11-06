# Projects

The Run composer discovers T3 projects, selects one, and adds an existing local Git
repository. Selection is saved across browser/backend restarts. Global Flows stay
available across all selections without assignment. Selecting an unavailable
project preserves its reference and explains why new Runs are blocked.

The composer's **Select project** dropdown shows the selected project's name,
repository path and icon supplied by T3. It displays T3 emoji, monogram and Lucide
icons with their configured color. When no explicit icon is set, a supported
repository image from T3’s `faviconPath` is displayed for local, available projects.
Missing or unreadable images fall back to a folder.
Lucide icons retain the full name and alias catalog supplied by the pinned library.
Factory serves only the requested icon's geometry from its backend; the browser bundle
contains the interface's statically imported icons, not the dynamic catalog. This requires
no external icon service and preserves the configured color and folder fallback.
Its choices show the same details with a vertically centered check
on the right of the current selection and an accent background; unavailable
projects remain selectable for history. Search by project name or repository
path at the top of the dropdown (case-insensitive). The wider dropdown limits
its height to the viewport and scrolls the project list independently, keeping
search and actions visible. Searching does not change the selected project.
Availability problems appear as text; project icons identify projects rather
than represent their availability. Last-known icons remain with unavailable
project references and refresh when T3 changes or removes the icon.
Choose **No project selected** to clear the selection. **Recheck projects** and
**Add repository** are actions inside the dropdown. Adding opens a dialog, retains
the entered path on failure and selects the project after a successful add.

T3 owns the project identifier, title and repository path. Factory periodically
reconciles them and offers **Recheck projects**. Rename/move/restore projects in
T3; Factory has no path editor, clone, initialization or repair workflow.

**Add repository** accepts an absolute path on the local backend/T3 host. Factory
validates the Git checkout and resolves symlinks and execution worktrees to their
source checkout, looks through the complete T3 project listing for that path,
then reuses its project or immediately registers it in T3. Registration explicitly
disables missing-directory creation. Independent clones stay separate; remote
URLs are never used to merge identity. An ambiguous association is reported for
resolution in T3, without a duplicate-selection workflow.

Project creation has no demonstrated idempotency key. A failed or lost create response is uncertain, never automatically retried.
Recheck projects before another add attempt: discovery may find the project that
T3 already created. Failed discovery blocks creation. Input remains in the form
on failure.

Saved references include endpoint, environment and T3 project id. Switching the
connection/environment retains earlier projects and selection, marks them
unavailable, and never substitutes a similarly named project on another machine.
Missing/deleted/archived T3 projects, missing directories and connection failures
retain their last title/path and observation time. New Runs require fresh project readiness; this is the project gate only, not proof of harness,
provisioning or overall execution readiness.

## Limits

Controlled tests verify persistence, reconciliation, outages, missing paths, environment changes, lookup/reuse, creation and ambiguous failures through public operations, and the real MCP SDK
against controlled OAuth/HTTP verifies paginated project lists and repository validation. This is not evidence of authenticated live T3 project behavior; project discovery, path reuse, creation,
T3 title/path changes and missing paths need verification against real T3 in neutral repositories, and duplicate or racing creation is unproven. T3 exposes list/create/read but no path lookup, so
Factory pairs paginated listing with canonical local-path comparison and checks the required schema fields in each authenticated session. Remote T3 repository validation is unsupported: directory checks
and add-repository work only with loopback T3 on the backend host. No workload is launched to check projects. The composer picker offers available projects only; a previously selected unavailable
reference stays displayed with its reason until explicitly replaced.

## Identity and API

A Factory UUID identifies a durable reference to an endpoint, environment and T3 project.
A worktree resolves to its source checkout; an independent clone is a distinct project,
even if both share a Git remote. Bare repositories are rejected.

Project icons may be normalized emoji, monograms or Lucide names. Unknown metadata falls
back without invalidating the project. Available same-host projects may supply repository
images: regular PNG, JPEG, GIF, WebP or ICO files up to 2 MiB, with no path escape, SVG or
HTML. The public URL is same-origin and never exposes the original path. Reads require
current project availability and authorization, retain Host/origin checks and use
`nosniff` and private, no-cache responses. Remote T3 paths are never read on the backend.

| HTTP | Purpose |
| --- | --- |
| `GET /api/projects` | Read the project catalog |
| `POST /api/projects/recheck` | Refresh discovery |
| `POST /api/projects` | Add a repository by absolute path |
| `PUT /api/projects/selection` | Select a saved project ID or clear with null |
| `GET /api/projects/:id/readiness` | Check project readiness |
| `GET` / `HEAD /api/projects/:id/favicon` | Read an authorized repository image |
| `GET /api/icons/lucide/:name` | Read one Lucide icon's geometry through the normal client authorization and protocol checks |

Discovery refreshes at startup, periodically and on explicit checks. Incomplete pagination,
invalid results or changed authorization fail the refresh, rather than reporting an empty
successful catalog. Missing records and their last-known identity remain available for
history. Project readiness must be combined with the other execution gates.
