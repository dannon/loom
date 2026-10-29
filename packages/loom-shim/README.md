# @galaxyproject/loom

Loom is now [Orbit](https://github.com/galaxyproject/orbit). This is the last
release under the old name: a shim that keeps the `loom` command working by
running the Orbit CLI it depends on, with the same arguments, after a one-line
notice.

Install Orbit directly and use `orbit` instead:

```bash
npm install -g @galaxyproject/orbit
orbit
```

Your configuration and sessions carry over. Orbit copies `~/.loom/` to
`~/.orbit/` the first time it runs and leaves a note behind in the old
directory. `LOOM_*` environment variables still work (with a warning) and
`ORBIT_*` is the name to move to.
