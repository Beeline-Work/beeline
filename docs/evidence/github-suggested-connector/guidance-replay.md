# General repository guidance replay

2026-10-19. Model: `anthropic/claude-sonnet-5.5`. Actual `assembleSessionPrompt`
for a Room without a repository and with unavailable shell, plus the actual
using-beeline skill. The request asks to fix a login bug from General with no
repository and unavailable gh. No provider credentials enter this artifact.
This is a model replay, not a deployed General conversation.

Observed assistant response:

Jellybean here. I can't touch your login bug from General because this Room has no repository, and repository changes only happen in a corner inside a linked repo.

**Next step:** link the repo that holds the project.

1. In the Room header, open **Repository → Link/Create**.
2. If your repo or organization isn't in the picker, choose **"Add repositories, accounts, or organizations"**. That opens the Beeline GitHub App install, where you grant access to the missing repo.
3. Alternatively, use the **+** in the Room list to create a repository-backed Room for that project.

You don't need a personal GitHub connection. The Beeline GitHub App provides the access.

Once it's linked, reply here with:
- the repo name,
- what the login bug does (the error message, or what you expected versus what happened),
- the steps to reproduce it, if you have them.

Then I can open a corner on that repo and work on the fix.

