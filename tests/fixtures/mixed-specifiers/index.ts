// Positive control for the module-identity test: b.ts is reached as `./b`
// here and as `./b.js` from c.ts, the exact pattern #649 was about.
import { b } from "./b";
import { c } from "./c";

export default () => b + c;
