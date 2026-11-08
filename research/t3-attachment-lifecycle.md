# T3 attachment upload lifecycle and multi-launch reuse

Research for issue #101 (parent #100, blocks #102).

## Sources and evidence levels

- **Source**: `pingdotgg/t3code` at commit `6417151c093e54dbba0e6c824c69d03983793b9a`
  (2026-11-08). That commit is the target of release tag `v0.1.8-nightly.20261108.4367`. Paths
  below are relative to that commit. Line numbers are at that commit.
- **Installed bundle**: T3 Code (Nightly) `0.1.8-nightly.20261108.4367`. Its server bundle has the
  same logic as the source above, so the installed build matches the cited source.
- **Live schemas**: `tools/list` from the same installed T3 over MCP, read on 2026-11-08.
- An older checkout (2026-10-17) still had `t3_thread_launch` documented as "no retry key". The
  `clientRequestId` on launch arrived between 2026-10-17 and 2026-11-08, so Factory must detect it
  from the schema rather than assume it.
- **No live upload was made.** Everything below comes from reading source and schemas. Claims about
  runtime behavior are code-read, not exercised end to end.

## 1. Upload: auth, request, response, errors

`t3_attachment_prepare_upload({ upload: { type, name, mimeType, sizeBytes } })` returns
`{ attachmentId, relativeUrl, expiresAt }` (`packages/contracts/src/assets.ts`,
`AttachmentCreateUploadUrlResult`).

- `attachmentId` is `pending-<uuid>` for images and `pending-<uuid>-<ext>` for files
  (`apps/server/src/attachmentStore.ts`, `createPendingAttachmentId`).
- `relativeUrl` is `/api/attachments/upload/<base64url claims>.<signature>`
  (`apps/server/src/assets/AttachmentUpload.ts:115`). The claims are type, id, name, mimeType,
  sizeBytes and expiresAt, signed with the server's asset signing key.
- `expiresAt` is epoch milliseconds: issue time + `ATTACHMENT_UPLOAD_URL_TTL_MS` = **10 minutes**
  (`packages/contracts/src/assets.ts:90`).

**Auth: the upload needs no OAuth bearer.** The signed token in the path is a capability URL.
The route `POST /api/attachments/upload/*` (`apps/server/src/http.ts:464`) is a plain HTTP router
route. It is mounted beside the `/mcp` transport, not inside it
(`apps/server/src/server.ts`, `layerMakeRoutes`). The MCP bearer middleware is attached only to the
`/mcp` transport (`apps/server/src/mcp/McpHttpServer.ts`, `layerMcpTransport` /
`makeMcpAuthMiddleware`). The route checks only the signature and expiry
(`AttachmentUpload.ts:123-143`). Sending the bearer anyway is harmless: it is ignored. Treat
`relativeUrl` as a secret until it expires.

**Request.** POST the exact raw bytes as the body, resolved against the MCP endpoint's origin. It
is not multipart, and no Content-Type is checked. If `Content-Length` is present it must equal
`sizeBytes`.

**Responses** (`http.ts:464-500`, `AttachmentUpload.ts:150-250`):

| Status | Body | Cause |
| --- | --- | --- |
| 204 | empty | Stored. Re-POSTing identical bytes to the same URL also returns 204 (idempotent). |
| 400 | `Content-Length must match the upload size.` | Header present and different from `sizeBytes`. |
| 400 | `Body was N bytes, expected M.` | Streamed body length differs from `sizeBytes`. |
| 404 | `Not Found` | Missing, malformed or forged token, or **expired URL** (after 10 minutes). |
| 409 | `Attachment already uploaded.` | The id already holds different bytes. |
| 500 | `Failed to persist upload.` / `Failed to resolve attachment path.` | Server I/O failure. |

Tool-level errors from `prepare_upload` are `OrchestratorMcpFailure`. An invalid `upload` (wrong
MIME, size outside limits) fails schema decoding before the handler runs.

**Linked environments.** `t3_thread_launch` with an `environmentId` that forwards to a linked peer
rejects any attachments: "A launch in a linked environment cannot carry attachments yet."
(`apps/server/src/peer/PeerForwarding.ts`, `forward`). Uploads are local to the server that issued
them.

## 2. Pending upload lifetime and `t3_attachment_discard`

- **Upload URL:** 10 minutes. After that the POST gets 404. A file already stored is unaffected.
- **Pending file:** deleted by `sweepStalePendingAttachments` once its mtime is older than
  **24 hours** (`attachmentStore.ts:30, 263`). The clock starts at upload completion, not at issue.
  `.part` leftovers from interrupted uploads are swept after 1 hour (`attachmentStore.ts:31`).
- **When the sweep runs:** at server startup (`apps/server/src/config.ts`) and lazily inside
  `prepare_upload`, at most once every 15 minutes (`AttachmentUpload.ts:38`). There is no timer, so
  24 hours is a minimum lifetime, not an exact expiry. A pending file can live longer on an idle
  server.
- **Claiming does not consume the pending file.** Each send or launch copies it to a new per-thread
  id. The pending file stays until it is swept or discarded (`AttachmentClaims.ts:66`: "Copies
  preserve the pending retry source after failed bootstrap; the pending sweep reclaims it").
- **`t3_attachment_discard({ attachmentId })`** deletes the pending file and its text sidecar. It
  never touches copies already delivered to threads (`attachment/tools.ts`, `AttachmentUpload.ts`
  `deletePendingAttachment`). Only the caller that prepared the upload may discard it
  (`attachment/handlers.ts:75`). Outside clients are identified by
  `requestNamespace = client:<OAuth session id>` (`apps/server/src/auth/McpOAuth.ts`,
  `layerMcpClientAuthenticator`).
- **Discard pitfall:** the owner map is **in memory**, with a TTL of 24 hours + 10 minutes
  (`handlers.ts:39`). After a T3 restart, or under a new Factory OAuth grant (new session id),
  discard fails with `invalid_request` ("Only the caller that prepared a pending upload can discard
  it."). The sweep is then the only cleanup. Discarding an id that was already swept succeeds
  silently: deleting a missing file is not an error.
- **Does discard matter?** Only for disk hygiene and to stop further use of the id. Nothing breaks
  if Factory never discards: the sweep reclaims the file after 24 hours or more.

## 3. One `attachmentId` across several `t3_thread_launch` calls

**Yes, per the implementation.** `launchThread` (`apps/server/src/orchestration-v2/ThreadMessageIntake.ts:210-250`)
calls `claimPendingAttachments`. That validates the pending file (it must exist and its stored size
must equal `sizeBytes`). It then **copies** the file to `<thread-segment>-<new uuid>` for the new
thread (`AttachmentClaims.ts:67-140`). The pending source is left in place, so the same pending id
can be claimed again by the next launch until it is swept or discarded. Each thread gets its own
copy, so editing or deleting one thread's copy does not affect the others.

Caveats:

- This is implementation behavior, not a documented contract. The tool descriptions say only
  "Upload is separate from sending". A future T3 build could start consuming pending ids. Factory
  should handle a "not found (removed or expired)" claim error even inside the 24-hour window.
- Pending ids are not scoped to their caller at claim time. Any authorized MCP caller that knows
  the id can attach it. Keep ids out of prompts and logs.
- Each launch accepts at most **8** attachments, and duplicate ids in one call are rejected
  (`AttachmentClaims.ts:78`).

Recommended Factory flow: upload each Run screenshot once, reuse its pending id in every
Flow-input worker launch, and discard only after every launch for that Run has a confirmed
response. Otherwise let the sweep reclaim it.

## 4. `t3_thread_launch` retry with the same `clientRequestId` plus attachments

The live schema has `clientRequestId` and the description says "After an error or lost reply,
retry with the same `clientRequestId`".

- **The key is derived like this:** `commandId = "mcp:launch:" + base64url(sha256(JSON([requestNamespace, clientRequestId])))`,
  and `threadId = messageId = commandId` (`apps/server/src/mcp/toolkits/project/handlers.ts:71, 100`).
  `requestNamespace` is `client:<OAuth session id>`, so **idempotency holds only within the same
  OAuth grant/session**. After reauthorization, the same key creates a different thread.
- **Replay:** if a thread already exists under that id, the handler uses the stored model and skips
  workspace/base checks (`handlers.ts:145`, `replaying`). `ThreadLaunchService.launch` replays the
  `thread.create` and `<commandId>:initial-message` command receipts
  (`apps/server/src/orchestration-v2/ThreadLaunchService.ts:973-1016`). A receipt replay only checks
  that the receipt's thread id matches. It does **not** compare the payload, so the original
  message and attachments win, and the response returns the original `threadId`/`runId`.
- **Attachments on replay:** `launchThread` runs `claimPendingAttachments` **before** the launch
  service, even when the call is a replay (`ThreadMessageIntake.ts:223`). On a successful replay
  the extra copies are removed again by `releaseUnusedClaims`, because they are not among the
  accepted message's attachments. No duplicate files remain.
- **Expired or discarded pending id on retry:** the claim fails first with
  `OrchestratorMcpFailure{code:"orchestration_error", message:"Attachment '<name>' cannot be sent: attachment not found (removed or expired)."}`.
  This happens **even if the thread was already created by the first attempt**: the replay never
  runs. So a retry is only clean while every referenced pending file still exists. Factory should
  not discard before every launch is confirmed, and should finish retries within the 24-hour pending
  lifetime.
- **Recovery after that error (code-read, not exercised):** a retry with the same `clientRequestId`
  and **without** `attachments` replays an existing launch, because payloads are not compared. If the
  first attempt never created the thread, the same call would instead create a thread without
  images. Use `t3_thread_list`/`t3_thread_read` to tell the two cases apart before choosing.
- **"Consumed" ids:** claiming does not consume them (see 3), so a retry after a successful first
  launch still finds the pending file.
- **Not pending:** an id that is not `pending-*` (for example a thread-owned id) is rejected with
  `invalid_request` "A new thread accepts only pending attachment uploads." (`handlers.ts:107`).
- `t3_thread_send_attachments` has **no retry key**: each call is a new message.

## 5. Detecting attachment support

There is no explicit capability flag. Detect from `tools/list`:

1. `t3_attachment_prepare_upload` is present, with `upload.{type,name,mimeType,sizeBytes}`.
   `t3_attachment_discard` is present too (optional; cleanup only).
2. The `t3_thread_launch` `inputSchema.properties` includes `attachments` (an array with
   `maxItems: 8` and items `{type, id, name, mimeType, sizeBytes}`) **and** `clientRequestId`. Both
   are needed for safe retries. Builds before roughly late October 2026 lacked a launch retry key.
3. MCP `initialize` returns `serverInfo { name: "T3 Code", version }`, where `version` is the server
   package version (`0.1.8-nightly.20261108.4367` in the installed build; `McpHttpServer.ts:1231`).
   It is informative only. Nightly versions do not mark contract changes, so prefer the schema
   checks, which match Factory's existing `inspectContractSupport` approach in
   `apps/backend/src/adapters/live-t3.ts`.
4. Uploads need HTTP POST reachability of the MCP endpoint's origin at `/api/attachments/upload/`.
   Whether a relay or proxy in front of T3 forwards that path is **UNVERIFIED**. Only a real upload
   can prove it.

## 6. MIME types and size limits

Constants are in `packages/contracts/src/chatAttachment.ts:14-23`.

| Check | Advertised in the live schema | Enforced |
| --- | --- | --- |
| Image MIME at `prepare_upload` | enum `image/gif`, `image/jpeg`, `image/png`, `image/webp` (unioned with the file branch's free string) | Same: `Schema.Literals(PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES)` for `type:"image"` (`assets.ts:95`). Other image types must go as `type:"file"`. |
| Image size at `prepare_upload` | 1..10,485,760 | 1 B .. 10 MiB (`assets.ts:98`) |
| File MIME / size | any string up to 100 chars; 1..52,428,800 | Same: 1 B .. 50 MiB (`assets.ts:108`) |
| Upload body | n/a | Byte count must equal `sizeBytes`. **No content sniffing.** Bytes are not checked against the MIME type. |
| Launch attachment item | `type`, `id`, `name`, `mimeType`, `sizeBytes`; image size 0..10 MiB, file 1..50 MiB | Image `mimeType` must match `^image/` (`chatAttachment.ts:152`). At claim time the stored size must equal `sizeBytes`, and the extension derived from type/MIME/name must match the upload, else "attachment type does not match the upload". So send back exactly the metadata used at prepare time. |
| Count per launch or send | `maxItems: 8` | 8 at the MCP boundary (`project/tools.ts:152`). The internal limit is 100. |
| Total image bytes per message | not advertised | 80 MiB (`chatAttachment.ts:16`, `getProviderAttachmentLimitError`); 8 × 10 MiB stays under it. |

Whether the selected provider can actually consume an image is decided by its adapter after
acceptance. Acceptance by T3 is not proof that the model saw the image (`t3_thread_send_attachments`
description: "Success does not mean the provider read them").

## UNVERIFIED

- End-to-end behavior: no upload, launch or discard was executed against a live T3.
- Whether relays or proxies in front of a remote T3 forward `POST /api/attachments/upload/*`.
- OAuth access-token lifetime, and so how often the session id behind `requestNamespace` changes.
  T3 only supports the `authorization_code` grant (`McpOAuth.ts`); Factory's own token handling
  determines when a new grant, and so a new idempotency/discard scope, appears.
- Stability of multi-launch reuse in future T3 builds. It is undocumented implementation behavior.
