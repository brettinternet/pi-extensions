import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export async function withHerdrBlocked<T>(
  pi: Pick<ExtensionAPI, "events">,
  label: string,
  action: () => Promise<T>,
): Promise<T> {
  pi.events.emit("herdr:blocked", { active: true, label });
  try {
    return await action();
  } finally {
    pi.events.emit("herdr:blocked", { active: false });
  }
}
