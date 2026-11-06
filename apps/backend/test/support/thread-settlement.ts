export const settleSchema = {
  type: "object",
  properties: {
    threadId: { type: "string" },
    action: { type: "string", enum: ["settle", "unsettle"] },
  },
  required: ["action"],
};
