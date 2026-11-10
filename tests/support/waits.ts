import { expect, type Screen } from "e2e";

/** Open the independently approved arrivals at the demo Flow's Soak Wait. */
export async function openPendingReviewWait(screen: Screen) {
  const soak = screen.getByRole("article", "Block Soak before release");
  await expect(soak).toContainText("2 pending");
  await expect(soak).not.toContainText("Needs input");
  await soak.getByRole("button", "Wait Soak before release", { exact: false }).tap();
  const details = screen.getByRole("complementary", "Block details");
  await expect(details.getByRole("listitem", "Arrival 1")).toContainText("waiting until");
  await expect(details.getByRole("listitem", "Arrival 2")).toContainText("waiting until");
  return { soak, details };
}
