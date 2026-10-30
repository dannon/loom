# Orbit's built-in skills

Skills Orbit writes and ships itself, before they are ready for
[galaxyproject/agentic-plugins](https://github.com/galaxyproject/agentic-plugins). Everything else
Orbit's model can fetch is vendored from there at a pinned commit; this directory is where a skill
Orbit needs can be tried with Orbit's own users first, and the good ones then move upstream.

The model reaches them as `skills_fetch({ repo: "orbit", path: "skills/<name>/SKILL.md" })`, and the
system-prompt router lists them under an `orbit` section.

## Writing one

- One directory per skill, named for its frontmatter `name`, with a `SKILL.md` and any reference
  files beside it. Text only; no symlinks.
- Frontmatter needs `name` and `description`, and `when_to_use` if the description alone doesn't
  say when to reach for it. Follow the galaxy-skills house style so the move upstream is a copy.
- `metadata.surfaces: [loom]` puts the skill in the router (one line in every system prompt).
  Leave it off for a skill that only a hint should point at; it stays fetchable by path. At least
  one skill here has to be tagged -- the router is tag-or-all.
- No paths into anybody's home directory; the sync refuses them.

## Shipping it

Files here are copied into `extensions/orbit/vendor/skills/` by the same sync as the agentic-plugins
content, so after any edit:

```bash
npm run sync:skills    # re-vendor and re-hash
npm run check:skills   # what CI runs; fails if this directory and the vendored copy disagree
```

`sync:skills` also fetches the agentic-plugins pin. To stay offline, point
`LOOM_AGENTIC_PLUGINS_DIR` at a checkout of agentic-plugins at the pinned commit.

A new or changed description changes the system prompt, so update the goldens too:
`npx vitest run -u tests/system-prompt-surface.test.ts`, and read the diff.

## Moving one upstream

Copy the directory into `plugins/galaxy-skills/skills/` in agentic-plugins, land it, bump the pin in
`scripts/skills.manifest.json`, delete it here, and re-sync. The path stays the same, so the only
thing that changes for the model is `repo: "orbit"` becoming the default repo. Forgetting the delete
fails the sync: two plugins would vendor the same file.
