import dynamicIconImports from "lucide-react/dynamicIconImports.mjs";
import { resultResponse } from "./http-support.ts";
import { failure } from "./result.ts";

/** Keep the runtime icon catalog on the server; send only the requested SVG geometry. */
export async function lucideIconResponse(name: string) {
  if (!Object.hasOwn(dynamicIconImports, name)) {
    return resultResponse(failure("not_found", "Project icon is unavailable."));
  }
  const icon = await dynamicIconImports[name as keyof typeof dynamicIconImports]();
  return resultResponse({ ok: true, value: icon.__iconData });
}
