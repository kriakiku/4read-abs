import pkg from "../package.json" with { type: "json" };

/** App version from package.json (CLI, API, UI). Embedded into the compiled binary. */
export const VERSION: string = pkg.version;
