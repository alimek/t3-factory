/** Package entry: the public backend surface. Each export lives in the module that owns it. */
export type { FactoryOptions } from "./factory-options.ts";
export { FactoryService } from "./factory-service.ts";
export { factoryLayer } from "./factory-layer.ts";
export { openFactory, type Factory } from "./open-factory.ts";
export type { T3Adapter, T3Endpoint, T3Inspection, T3Target } from "./adapters/t3.ts";
export { LiveT3Adapter } from "./adapters/live-t3.ts";
export type { RuntimeReport, RuntimeReply } from "./runtime-types.ts";
