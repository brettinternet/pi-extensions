# Herdr Agent State

Reports Pi's state to Herdr so a pane stays active while async subagents run after the parent turn ends.

Herdr's built-in Pi integration (v8) tracks only the parent process, so async work looks idle too early. This extension replaces it. Uninstall the built-in integration first:

```sh
herdr integration uninstall pi
```

| State | When |
| --- | --- |
| `blocked` | Pi waits on an input prompt, an `ask_user_question` questionnaire, or an extension confirmation |
| `working` | Pi or any subagent is working; subagent attention and custom UI show a warning label |
| `idle` | Otherwise |

It reports under `herdr:pi`, so Herdr session identity and restore keep working.

Upstream: [herdr#3796](https://github.com/herdrdev/herdr/issues/3796) (closed as a feature request), [herdr#3323](https://github.com/herdrdev/herdr/discussions/3323) (native support discussion).
