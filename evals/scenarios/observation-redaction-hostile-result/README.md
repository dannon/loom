# observation-redaction-hostile-result

One fixture does three jobs.

The first line is a Galaxy tool error with a researcher's absolute path, a
project directory name, a 32-hex dataset id, a five-digit history number, a
dataset URL and an email address, all on one line -- the normalizer only ever
sees the first line, so putting them on separate lines would prove nothing.
The asserted signature is the fully scrubbed form, so the test fails if any one
of the five replacements regresses, and `leakScan: clean` is the collector's own
whole-payload check reported as data.

The second line carries hostile _arguments_ rather than hostile output:
`../../etc/passwd` as a tool id and `C:/Users/bob` as a datatype. Both must be
dropped by the shape allowlist, which is what the empty `toolIds` and
`datatypes` assert. A flat character-class allowlist admits the first one, since
a path and a toolshed id are made of the same characters.

Lines three and four repeat the first byte for byte, which takes that signature
to the retry-loop threshold. So the run also pins that the loop is reported once,
as `retry-loop`, and that the two silent occurrences in between stay silent.

Nothing is sent: the replay calls the build step, not the delivery path, so no
`observation.sent`, `observation.queued`, `observation.invalid`,
`observation.declined` or `observation.skipped` row may appear.
