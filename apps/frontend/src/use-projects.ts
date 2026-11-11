import { useEffect, useState } from "react";
import type { FactoryProject } from "@t3-factory/contracts";
import { api } from "./api.ts";

/** The project catalog, read again when `key` changes; undefined until a read succeeds. */
export function useProjects(key?: string) {
  const [projects, setProjects] = useState<readonly FactoryProject[]>();
  useEffect(() => {
    let active = true;
    setProjects(undefined);
    void api.listProjects().then(
      (catalog) => {
        if (active) setProjects(catalog.projects);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [key]);
  return projects;
}
