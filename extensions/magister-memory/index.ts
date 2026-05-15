import { definePluginEntry } from "openclaw/plugin-sdk/core";

export default definePluginEntry({
  id: "magister-memory",
  name: "Magister Memory",
  description:
    "Bounded, file-backed agent memory with tool-mediated writes, threat scanning, and gateway audit mirroring.",
  register(_api) {
    // Tool registration lands in Task 8.
  },
});
