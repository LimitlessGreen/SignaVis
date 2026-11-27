# models/

Model folders the web app serves under `models/`. They are not committed:

```sh
npm run models:fetch                 # all models
npm run models:fetch -- birdnet-v3.0 # only some
```

`scripts/fetch-models.mjs` lists the sources (pinned) and SHA-256 sums, and its header names each model's license.
The Pages workflow runs it before the demo build.
