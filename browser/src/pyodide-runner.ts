function toDict(payload: any) {
    return `json.loads(${JSON.stringify(JSON.stringify(payload))})`;
}

export async function runOlite(pyodide: any, config: any, transcripts: any, onEvent?: (event: any) => void) {
    const inputs = { transcripts };
    pyodide.onEvent = onEvent;
    try {
        const raw = await pyodide.runPythonAsync([
            "import json",
            "from js import oliteEmit",
            "from olite import run",
            `config = ${toDict(config)}`,
            `inputs = ${toDict(inputs)}`,
            "def _on_event(ev):",
            "    oliteEmit(json.dumps(ev))",
            "result = await run(config, inputs, _on_event)",
            "json.dumps(result)",
        ]);
        if (typeof raw !== "string") {
            throw new Error("Did not return JSON.");
        }
        return JSON.parse(raw);
    } finally {
        pyodide.onEvent = undefined;
    }
}
