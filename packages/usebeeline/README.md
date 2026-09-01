# usebeeline

Connect a supported coding-agent harness to Beeline:

```sh
npx usebeeline connect <PAIRING_CODE_FROM_THE_APP>
```

The package also exposes a `beeline` bin alias. The connect command uses the
short-lived code minted by the Beeline app, installs the signed current daemon bundle into
the canonical `~/.local` layout, and starts the supervised user service.

The wizard asks exactly for the harness, any required provider credential, the
model, and the agent's soul. OpenRouter defaults to GLM 5.3 Flash.
