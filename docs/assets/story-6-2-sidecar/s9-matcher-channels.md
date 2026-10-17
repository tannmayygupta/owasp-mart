# Spike S-9: what the sidecar matcher sees (story 6.2, task L-20)

Question: does the matcher see a flag through JSON escaping and gzip, and which channels can it not see?

Method: each row builds one response that carries one real flag (a throw-away value made for this run) in one channel, and runs it through the
matcher the sidecar uses (`services/sidecar/src/matcher.mjs`): content-encoding is undone (gzip, deflate, brotli), then JSON string escapes, HTML
entities and percent encoding are undone in every chain of up to three layers, then `VM{[A-Z2-7]{24}}` is searched and each distinct hit is hashed
with SHA-256 and looked up in the digest set. The scan copy is bounded at 1048576 bytes (1 MiB); a decoded size above 4 MiB is not scanned.
The same rows run end to end through the player port in `services/sidecar/test/sidecar.test.mjs` (bytes to the player are compared too).
This table is produced by `node services/sidecar/scripts/s9-table.mjs`.

| Channel | Expected | Result | Detail | Verdict |
|---|---|---|---|---|
| plain text | seen | seen | candidate found, class real | ok |
| JSON string, plain | seen | seen | candidate found, class real | ok |
| JSON with braces as unicode escapes | seen | seen | candidate found, class real | ok |
| JSON, every character as a unicode escape | seen | seen | candidate found, class real | ok |
| JSON with escaped slashes around it | seen | seen | candidate found, class real | ok |
| gzip | seen | seen | candidate found, class real | ok |
| deflate (zlib) | seen | seen | candidate found, class real | ok |
| brotli | seen | seen | candidate found, class real | ok |
| gzip around JSON escapes | seen | seen | candidate found, class real | ok |
| HTML numeric entities for the braces | seen | seen | candidate found, class real | ok |
| HTML named entities for the braces | seen | seen | candidate found, class real | ok |
| HTML hex and decimal entities for every character | seen | seen | candidate found, class real | ok |
| percent-encoded braces | seen | seen | candidate found, class real | ok |
| every character percent-encoded | seen | seen | candidate found, class real | ok |
| inside a JSON string inside HTML (script tag) | seen | seen | candidate found, class real | ok |
| HTML entities inside a JSON string | seen | seen | candidate found, class real | ok |
| cut at a chunk border (joined before the scan) | seen | seen | candidate found, class real | ok |
| base64 of the flag | not seen | not seen | no candidate | ok |
| hex of the flag | not seen | not seen | no candidate | ok |
| reversed string | not seen | not seen | no candidate | ok |
| split by markup inside the flag | not seen | not seen | no candidate | ok |
| flag cut off by the caller (a prefix only) | not seen | not seen | no candidate | ok |
| lower-case copy of the flag | not seen | not seen | no candidate | ok |
| body in UTF-16 | not seen | not seen | no candidate | ok |
| content-encoding the sidecar cannot decode (zstd) | not seen | not seen | skipped: unsupported | ok |
| response above the 1 MiB scan cap | not seen | not seen | skipped: too_big | ok |
| unrelated binary with no flag (control row) | not seen | not seen | no candidate | ok |

Not seen channels use paste (FR-FLG-06): the player pastes the flag into the shop and the platform checks it. A response over another protocol (for
example a WebSocket after an upgrade) does not pass the matcher at all. Rows are results of a local run on one machine; the unit of the claim is
this matcher code, not a measurement of the real shop's pages (the shop owns where flags appear).
