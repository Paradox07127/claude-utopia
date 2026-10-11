# next-prompt

Next-prompt prediction for Claude Code, built on [mods](https://code.claude.com/docs/en/plugins/mods/overview).

After each main-thread turn that ends with an answer, the plugin makes one `$.model.fork`: the session's own model, reusing its prompt cache, with no tools, and nothing written to the transcript. The fork reads the conversation, your recent typed prompts in this project and the short messages you send often, and writes the message you are likely to send next. The plugin shows it as the prompt box's dim suggestion; press Tab to take it. A reply of `NONE` (or an empty or overlong one) shows nothing and counts as an abstention. Subagent turns do not fork.

## Claude Code's own suggestion

In the terminal the plugin hides Claude Code's own prompt suggestion, so only its prediction shows. In the desktop app that hook does not run ([anthropics/claude-code#99876](https://github.com/anthropics/claude-code/issues/99876)), so set `"promptSuggestionEnabled": false` in your settings to keep the two from competing.

## /prediction-stats

Prints, over the logged outcomes: how many shown suggestions were taken (the prompt you sent starts with the suggestion), how many were near-taken (edit distance within 30% of the suggestion's length), the mean characters kept, the abstentions, the median fork time, and the share of fork input tokens read from cache. It answers in Chinese or English, following the settings `language`, then `LC_ALL` / `LANG`.

## What it keeps

In the plugin store:

- The last 300 prompts you typed (in the terminal, through Remote Control, or in the desktop app; not slash commands), each with its session's directory, 300 characters each.
- The last 500 outcomes: each shown suggestion with the prompt you sent after it, 300 characters each, plus the fork time, token counts and edit distance.
- The count of abstentions.

A `-p` run neither forks nor records.

## Cost

One fork per main-thread turn, billed to your session; most of its input is read from the prompt cache.

## Options

None.
