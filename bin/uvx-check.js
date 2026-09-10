// Compatibility re-export. The implementation moved to shared/uvx-runner.js so
// the brain can reuse it (see that file's header); the CLI keeps importing from
// here.
export { resolveExecutable, isUvxAvailable, uvxMissingNotice } from "../shared/uvx-runner.js";
