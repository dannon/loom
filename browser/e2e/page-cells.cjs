// The cell types Galaxy's page parser renders; its server refuses a page carrying any other ```
// fence. Shared by the e2e stub and the conformance test's page stub, so both refuse what Galaxy
// refuses.
const PAGE_CELLS = ["galaxy", "markdown", "vega", "visualization", "vitessce"];

/** The first fence line Galaxy would refuse, or undefined. */
const badFence = (content) =>
    String(content || "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("```") && line.length > 3 && !PAGE_CELLS.includes(line.slice(3)));

module.exports = { PAGE_CELLS, badFence };
