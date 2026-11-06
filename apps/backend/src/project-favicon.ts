import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import type { ProjectFavicon, Result, T3Connection } from "@t3-factory/contracts";
import { isLocalEndpoint } from "./endpoint-local.ts";
import { failure as operationFailure } from "./result.ts";

const FAVICON_BYTE_LIMIT = 2 * 1024 * 1024;
const notFound = (): Result<never> =>
  operationFailure("not_found", "Project favicon is unavailable.", []);

export function projectFaviconUrl(id: string, faviconPath: string | null): string | null {
  if (!faviconPath) return null;
  const version = createHash("sha256").update(faviconPath).digest("hex").slice(0, 16);
  return `/api/projects/${id}/favicon?v=${version}`;
}

const imageSignatures = [
  { prefix: "89504e470d0a1a0a", contentType: "image/png" },
  { prefix: "ffd8ff", contentType: "image/jpeg" },
  { prefix: "474946383761", contentType: "image/gif" },
  { prefix: "474946383961", contentType: "image/gif" },
  { prefix: "00000100", contentType: "image/x-icon" },
];

const imageContentType = (bytes: Uint8Array): string | null => {
  if (bytes.length < 12) return null;
  const header = Buffer.from(bytes.subarray(0, 12));
  if (header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  const hex = header.toString("hex");
  return imageSignatures.find(({ prefix }) => hex.startsWith(prefix))?.contentType ?? null;
};

const confinedProjectFile = async (
  workspaceRoot: string,
  relativePath: string,
): Promise<string | null> => {
  if (relativePath.includes("\0")) return null;
  const normalized = normalize(relativePath);
  if (isAbsolute(normalized) || normalized.startsWith("..") || normalized.split(sep).includes(".."))
    return null;
  const root = await realpath(workspaceRoot).catch(() => null);
  if (!root) return null;
  const candidate = join(root, normalized);
  const resolved = await realpath(candidate).catch(() => null);
  if (!resolved || (!resolved.startsWith(root + sep) && resolved !== root)) return null;
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile()) return null;
  return resolved;
};

const readBoundedImage = async (path: string): Promise<Uint8Array | null> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > FAVICON_BYTE_LIMIT) return null;
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    if (bytesRead !== info.size) return null;
    return new Uint8Array(buffer);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
};

export async function loadProjectFavicon(
  connection: Result<T3Connection>,
  project: {
    endpoint: string;
    environmentId: string;
    workspaceRoot: string;
    availability: string;
    faviconPath: string | null;
  },
): Promise<Result<ProjectFavicon>> {
  if (
    !connection.ok ||
    connection.value.state !== "ready" ||
    !connection.value.authorizationContext ||
    project.availability !== "available" ||
    !project.faviconPath ||
    !isLocalEndpoint(project.endpoint)
  )
    return notFound();
  const context = connection.value.authorizationContext;
  if (context.endpoint !== project.endpoint || context.environmentId !== project.environmentId)
    return notFound();
  const file = await confinedProjectFile(project.workspaceRoot, project.faviconPath);
  if (!file) return notFound();
  const data = await readBoundedImage(file);
  if (!data) return notFound();
  const contentType = imageContentType(data);
  if (!contentType) return notFound();
  return { ok: true, value: { contentType, data } };
}
