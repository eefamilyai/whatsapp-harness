import { config } from "../config.js";
import { formatWhen, toIsoWithOffset } from "../time.js";
import { str, type Tool } from "./types.js";

export const getTime: Tool = {
  name: "get_time",
  description: "Current date and time, optionally in another IANA time zone (e.g. Europe/London).",
  parameters: {
    type: "object",
    properties: { timezone: { type: "string", description: "IANA zone; default is the user's zone." } },
  },
  async run(args) {
    const tz = str(args.timezone) ?? config.timezone;
    try {
      const now = Date.now();
      return `${formatWhen(now, tz)} (${tz}), ISO ${toIsoWithOffset(now, tz)}`;
    } catch {
      throw new Error(`Unknown time zone "${tz}".`);
    }
  },
};
