# observation-redaction-hostile-result

One fixture does four jobs. It replays in the default `ask` shape, the one that
carries a signature.

The first line is a Galaxy tool error with a researcher's absolute path, a
project directory name, a 32-hex dataset id, a five-digit history number, a
dataset URL and an email address, all on one line -- the normalizer only ever
sees the first line, so putting them on separate lines would prove nothing. The
leak scan runs over that raw line before the normalizer rewrites it, so the
observation is refused outright (`leakScan: dirty`) rather than scrubbed and
sent, and its signature is withheld from the activity row.

The second line carries hostile _arguments_ rather than hostile output:
`../../etc/passwd` as a tool id and `C:/Users/bob` as a datatype, with a
`~/bin` path in the text. The text alone refuses it.

Lines three and four repeat the first byte for byte, which takes that signature
to the retry-loop threshold. So the run also pins that the loop is reported once,
as `retry-loop`, that the silent occurrence in between stays silent, and that
the loop report is refused for the same reason as the first.

The fifth line is a clean failure, and shows what does pass: the normalized
signature (the five-digit job number becomes `<n>`), the public toolshed id
with its version split off, and the datatype.

Nothing is sent: the replay calls the build step, not the delivery path, so no
`observation.sent`, `observation.queued`, `observation.invalid`,
`observation.declined` or `observation.skipped` row may appear.
