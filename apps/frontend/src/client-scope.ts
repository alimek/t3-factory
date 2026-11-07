import { createContext, useContext } from "react";

/** Provided by the client gate once product screens may mount. */
export const ScopeContext = createContext<"host" | "remote">("host");

/** `host`: the owner's local panel. `remote`: an approved client without host setup controls. */
export const useClientScope = () => useContext(ScopeContext);
